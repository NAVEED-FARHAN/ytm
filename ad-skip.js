// Electron preload: starts before YouTube's document renders and only changes media state.
// It never blocks, alters, or cancels any network request.
(() => {
  const { ipcRenderer } = require('electron');
  if (window.__youtubeTrayAdGuardInstalled) return;
  window.__youtubeTrayAdGuardInstalled = true;

  ipcRenderer.send('ad-skip:loaded');

  function hideScrollbars() {
    if (!document.head || document.getElementById('youtube-tray-scrollbar-style')) {
      if (!document.head) setTimeout(hideScrollbars, 0);
      return;
    }

    const style = document.createElement('style');
    style.id = 'youtube-tray-scrollbar-style';
    style.textContent =
      'html, body { scrollbar-width: none !important; }' +
      'html::-webkit-scrollbar, body::-webkit-scrollbar, *::-webkit-scrollbar { width: 0 !important; height: 0 !important; background: transparent !important; }';
    document.head.appendChild(style);
  }

  // YouTube's ad-related class names change periodically. All page-specific
  // selectors are centralised here; update this object when YouTube drifts.
  const SELECTORS = {
    // The player element gains these classes during in-stream ads.
    adPlayer: [
      '#movie_player.ad-showing',
      '#movie_player.ad-interrupting',
      '.html5-video-player.ad-showing',
      '.html5-video-player.ad-interrupting',
      '.ad-showing'
    ].join(', '),

    // Visible ad UI chrome (overlays, preview text, countdowns).
    adUi: [
      '.ytp-ad-player-overlay',
      '.ytp-ad-player-overlay-instream',
      '.ytp-ad-text',
      '.ytp-ad-preview-container',
      '.ytp-ad-player-overlay-layout',
      '.ytp-ad-image-overlay',
      '.ytp-ad-action-interstitial'
    ].join(', '),

    // Every known incarnation of the "Skip Ad" button.
    skip: [
      '.ytp-ad-skip-button',
      '.ytp-ad-skip-button-modern',
      '.ytp-skip-ad-button',
      '.ytp-ad-skip-button-slot button',
      '.ytp-ad-skip-button-container button',
      '[id^="skip-button"]',
      'button[aria-label*="Skip ad" i]',
      '.ytp-ad-skip-button-container',
      'button.ytp-ad-skip-button',
      'button.ytp-ad-skip-button-modern',
      '.ytp-ad-skip-button-slot',
      'button[class*="skip-button"]',
      'button[class*="skip-ad"]',
      '.ytp-ad-button[class*="skip"]',
      'ytd-button-renderer#skip-button button',
      'tp-yt-paper-button.ytp-ad-skip-button',
      '.ytp-ad-skip-button-modern-with-label',
      'button.ytp-ad-skip-button-modern-with-label',
      'div[id^="skip-button"] button',
      '.ytp-ad-skip-button-text',
      'button[aria-label*="Skip" i]'
    ].join(', '),

    // Overlay / banner ad close buttons.
    overlayClose: [
      '.ytp-ad-overlay-close-button',
      '.ytp-ad-overlay-close-container button',
      '.ytp-ad-overlay-close-container',
      '[aria-label="Close ad" i]',
      '[aria-label="Close" i].ytp-ad-overlay-close-button',
      '.ytp-ad-overlay-close-button button'
    ].join(', ')
  };

  const POLL_INTERVAL_MS = 100;
  const SKIP_CLICK_COOLDOWN_MS = 400;
  const SEEK_COOLDOWN_MS = 500;
  const AD_PLAYBACK_RATE = 16;
  const DEBUG = false;

  let adActive = false;
  let savedVolume = 1;
  let wasManuallyMuted = false;
  let savedPlaybackRate = 1;
  let lastSkipClickAt = 0;
  let lastSeekAt = 0;

  function log(...args) {
    if (DEBUG) console.log('[YT-Tray Ad Guard]', ...args);
  }

  // --- Helpers ---

  function getVideo() {
    return document.querySelector('video.html5-main-video, #movie_player video, video');
  }

  // Rejects elements that are hidden, fully transparent, disabled, or
  // scrolled outside the visible viewport (avoids the y = -980 ghost button).
  function isVisible(el) {
    if (!el || !el.isConnected || el.disabled) return false;
    const s = window.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const rects = el.getClientRects();
    if (rects.length === 0) return false;
    const r = rects[0];
    return r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
  }

  // --- Ad Detection ---

  function isAdPlaying(video) {
    const player = video.closest('.html5-video-player') || document.querySelector('#movie_player');
    if (player?.classList.contains('ad-showing') || player?.classList.contains('ad-interrupting')) {
      return true;
    }
    if (document.querySelector(SELECTORS.adPlayer)) return true;
    return [...document.querySelectorAll(SELECTORS.adUi)].some(isVisible);
  }

  // --- Skip Button ---

  function findSkipButton() {
    const selectorHit = [...document.querySelectorAll(SELECTORS.skip)].find(isVisible);
    if (selectorHit) {
      log('Skip button (selector):', selectorHit.className || selectorHit.id);
      return selectorHit;
    }

    if (!adActive) return null;
    const textHit = [...document.querySelectorAll('button, [role="button"]')].find((el) => {
      const label = `${el.textContent || ''} ${el.getAttribute('aria-label') || ''}`;
      return isVisible(el) && /skip\s*(ad|ads)|ad\s*skip/i.test(label);
    });
    if (textHit) log('Skip button (text):', textHit.textContent?.trim());
    return textHit || null;
  }

  // --- Overlay Ads ---

  function dismissOverlayAds() {
    const closeBtn = [...document.querySelectorAll(SELECTORS.overlayClose)].find(isVisible);
    if (closeBtn) {
      log('Dismissing overlay ad');
      closeBtn.click();
    }
  }

  // --- Audio & Playback ---

  function muteAd(video) {
    video.muted = true;
    if (video.volume !== 0) video.volume = 0;
  }

  // Accelerate the ad so unskippable pre-rolls finish almost instantly.
  // Enforced continuously because YouTube can reset the rate or swap the element.
  function speedUpAd(video) {
    try {
      video.playbackRate = AD_PLAYBACK_RATE;
    } catch (_) { /* some streams reject extreme rates */ }
  }

  function restorePlayback(video) {
    video.volume = savedVolume;
    video.muted = wasManuallyMuted;
    try { video.playbackRate = savedPlaybackRate; } catch (_) {}
  }

  // --- Strategy A: Seek the ad video to its end ---

  function seekPastAd(video) {
    const now = Date.now();
    if (now - lastSeekAt < SEEK_COOLDOWN_MS) return;
    lastSeekAt = now;

    try {
      const dur = video.duration;
      if (dur && isFinite(dur) && dur > 0 && video.currentTime < dur - 0.5) {
        log('Seeking ad:', video.currentTime.toFixed(1), '->', (dur - 0.1).toFixed(1));
        video.currentTime = dur - 0.1;
      }
    } catch (e) {
      log('Seek error:', e.message);
    }
  }



  // --- Strategy C: Click the skip button (DOM + native input) ---

  function clickSkip(button) {
    const now = Date.now();
    if (now - lastSkipClickAt < SKIP_CLICK_COOLDOWN_MS) return;
    lastSkipClickAt = now;

    if (!adActive || !isVisible(button)) return;

    // Capture coordinates BEFORE any DOM manipulation — the click/dispatchEvent
    // calls below can trigger a re-render that moves the element, causing the
    // post-click getBoundingClientRect to return garbage (e.g. y = -980).
    const rect = button.getBoundingClientRect();

    log('Clicking skip:', button.tagName, button.className || button.id,
      'text:', button.textContent?.trim().substring(0, 30),
      'rect:', JSON.stringify({ x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }));

    // Layer 1 — DOM methods
    try {
      button.focus();
      button.click();

      const opts = { bubbles: true, cancelable: true, view: window };
      button.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, isPrimary: true }));
      button.dispatchEvent(new MouseEvent('mousedown', { ...opts, button: 0 }));
      button.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1, isPrimary: true }));
      button.dispatchEvent(new MouseEvent('mouseup', { ...opts, button: 0 }));
      button.dispatchEvent(new MouseEvent('click', { ...opts, button: 0 }));

      let parent = button.parentElement;
      for (let i = 0; i < 2 && parent; i++, parent = parent.parentElement) {
        parent.click();
      }
    } catch (e) {
      log('DOM click error:', e.message);
    }

    // Layer 2 — trusted native input via main process, using the rect captured
    // BEFORE DOM manipulation. Clamp to the visible portion of the button so
    // the coordinates are always within the viewport (the button may overflow
    // the narrow 410 px window on its right edge).
    if (rect.width > 0 && rect.height > 0) {
      const visLeft = Math.max(0, rect.left);
      const visTop = Math.max(0, rect.top);
      const visRight = Math.min(window.innerWidth, rect.right);
      const visBottom = Math.min(window.innerHeight, rect.bottom);

      if (visRight > visLeft && visBottom > visTop) {
        ipcRenderer.send('ad-skip:click-visible-button', {
          x: Math.round((visLeft + visRight) / 2),
          y: Math.round((visTop + visBottom) / 2)
        });
      }
    }
  }

  // --- Main Loop ---

  function tick() {
    const video = getVideo();
    if (!video) return;

    const adPlaying = isAdPlaying(video);

    // — Ad just started —
    if (adPlaying && !adActive) {
      adActive = true;
      savedVolume = video.volume;
      wasManuallyMuted = video.muted;
      savedPlaybackRate = video.playbackRate;
      lastSkipClickAt = 0;
      lastSeekAt = 0;
      log('Ad started — muting, accelerating, seeking');
    }

    if (adPlaying) {
      // Enforced every tick: YouTube can swap the media element or reset state.
      muteAd(video);
      speedUpAd(video);

      // Skip strategies, all rate-limited internally:
      seekPastAd(video);     // A: jump to end of ad video
      dismissOverlayAds();
      const skip = findSkipButton();
      if (skip) clickSkip(skip);  // C: DOM + native click
    } else if (adActive) {
      // — Ad just ended —
      adActive = false;
      log('Ad ended — restoring playback');
      restorePlayback(video);
    }
  }

  // --- Bootstrap ---

  function startObserver() {
    if (!document.documentElement) {
      setTimeout(startObserver, 0);
      return;
    }
    new MutationObserver(tick).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'disabled', 'aria-label', 'style']
    });
  }

  setInterval(tick, POLL_INTERVAL_MS);
  startObserver();
  hideScrollbars();
  tick();
  log('Ad guard installed and running');
})();
