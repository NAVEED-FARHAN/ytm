// Electron preload: starts before YouTube's document renders and only changes media state.
// It never blocks, alters, or cancels any network request.
(() => {
  const { ipcRenderer } = require('electron');
  if (window.__youtubeTrayAdGuardInstalled) return;
  window.__youtubeTrayAdGuardInstalled = true;

  const SELECTORS = {
    adPlayer: [
      '#movie_player.ad-showing',
      '.html5-video-player.ad-showing',
      '.ad-showing'
    ].join(', '),
    adUi: [
      '.ytp-ad-player-overlay',
      '.ytp-ad-player-overlay-instream',
      '.ytp-ad-text',
      '.ytp-ad-preview-container'
    ].join(', '),
    skip: [
      '#movie_player .ytp-ad-skip-button',
      '#movie_player .ytp-ad-skip-button-modern',
      '#movie_player .ytp-skip-ad-button',
      '#movie_player .ytp-ad-skip-button-slot button',
      '#movie_player .ytp-ad-skip-button-container button',
      '#movie_player [id^="skip-button"]',
      'button[aria-label*="Skip ad" i]'
    ].join(', ')
  };

  const POLL_INTERVAL_MS = 100;
  let adActive = false;
  let savedVolume = 1;
  let wasManuallyMuted = false;
  let lastSkipButton = null;
  let lastSkipAttempt = 0;

  function getVideo() {
    return document.querySelector('video.html5-main-video, #movie_player video, video');
  }

  function isVisible(element) {
    if (!element || !element.isConnected || element.disabled) return false;
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  }

  function isAdPlaying(video) {
    const player = video.closest('.html5-video-player') || document.querySelector('#movie_player');
    if (player?.classList.contains('ad-showing')) return true;
    if (document.querySelector(SELECTORS.adPlayer)) return true;
    return [...document.querySelectorAll(SELECTORS.adUi)].some(isVisible);
  }

  function findSkipButton() {
    const selectorMatch = [...document.querySelectorAll(SELECTORS.skip)].find(isVisible);
    if (selectorMatch) return selectorMatch;

    // Class names drift periodically; only use text as a fallback while an ad is active.
    return [...document.querySelectorAll('button, [role="button"]')].find((element) => {
      const label = `${element.textContent || ''} ${element.getAttribute('aria-label') || ''}`;
      return isVisible(element) && /skip\s*(ad|ads)|ad\s*skip/i.test(label);
    });
  }

  function muteAd(video) {
    video.muted = true;
    if (video.volume !== 0) video.volume = 0;
  }

  function restoreAudio(video) {
    video.volume = savedVolume;
    video.muted = wasManuallyMuted;
  }

  function skipImmediately(button) {
    const now = Date.now();
    if (button === lastSkipButton && now - lastSkipAttempt < 350) return;

    lastSkipButton = button;
    lastSkipAttempt = now;
    if (!adActive || !isVisible(button)) return;

    const bounds = button.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;

    // Native renderer input is trusted by YouTube, unlike HTMLElement.click().
    ipcRenderer.send('ad-skip:click-visible-button', {
      x: Math.round(bounds.left + bounds.width / 2),
      y: Math.round(bounds.top + bounds.height / 2)
    });
  }

  function tick() {
    const video = getVideo();
    if (!video) return;

    const adPlaying = isAdPlaying(video);
    if (adPlaying && !adActive) {
      adActive = true;
      savedVolume = video.volume;
      wasManuallyMuted = video.muted;
    }

    if (adPlaying) {
      // Enforce muting continuously because YouTube can replace the media element during an ad.
      muteAd(video);
      const skipButton = findSkipButton();
      if (skipButton) skipImmediately(skipButton);
    } else if (adActive) {
      adActive = false;
      restoreAudio(video);
    }
  }

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
  tick();
})();
