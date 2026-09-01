const { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, screen, Tray } = require('electron');
const path = require('path');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// nativeImage cannot decode SVG, so the tray uses the pre-rendered PNG pair
// (tray.png + tray@2x.png is picked automatically on high-DPI displays).
const iconPath = path.join(__dirname, 'assets', 'tray.png');
const WINDOW_WIDTH = 410;
const WINDOW_HEIGHT = 760;
const FLYOUT_GAP = 12;
const FLYOUT_SHOW_DURATION_MS = 300;
const FLYOUT_HIDE_DURATION_MS = 200;
const TOGGLE_SHORTCUT = 'Alt+`';
const PANEL_HEIGHT_RATIO = 0.7;
const MIN_PANEL_HEIGHT = 480;

// Self-contained ad-skip logic injected into the YouTube page's main world
// via guestWebContents.executeJavaScript().  Running in the page's own JS
// context lets us call player.skipAd(), override playbackRate descriptors,
// defeat YouTube's ratechange / seeked event-handler resets, and — crucially —
// override addEventListener on skip-button elements so that YouTube's own
// click handlers see event.isTrusted === true for our synthetic clicks.
const MAIN_WORLD_AD_SKIP = `(function() {
  if (window.__ytTrayMainWorldAdSkip) return;
  window.__ytTrayMainWorldAdSkip = true;

  var AD_RATE = 16;
  var POLL_MS = 100;
  var API_COOLDOWN_MS = 800;
  var SKIP_COOLDOWN_MS = 300;
  var adActive = false;
  var rateIntercepted = false;
  var savedRate = 1;
  var interceptedVideo = null;
  var lastApiAt = 0;
  var lastSkipAt = 0;
  var trustedOverrideInstalled = false;

  // --- Skip-button class names (from yt-ad-autoskipper + our own) ---
  var SKIP_SELECTORS = [
    '.ytp-skip-ad-button',
    '.ytp-ad-skip-button',
    '.ytp-ad-skip-button-modern',
    'button.ytp-ad-skip-button',
    'button.ytp-ad-skip-button-modern',
    '.ytp-ad-skip-button-slot button',
    '.ytp-ad-skip-button-container button',
    '.ytp-ad-skip-button-container',
    '.ytp-ad-skip-button-slot',
    '[id^="skip-button"]',
    'button[aria-label*="Skip ad" i]',
    'button[class*="skip-button"]',
    'button[class*="skip-ad"]',
    '.ytp-ad-skip-button-modern-with-label',
    'button.ytp-ad-skip-button-modern-with-label',
    'div[id^="skip-button"] button',
    '.ytp-ad-skip-button-text',
    '.videoAdUiSkipButton'
  ];

  var OVERLAY_CLOSE_SELECTORS = [
    '.ytp-ad-overlay-close-button',
    '.ytp-ad-overlay-close-container button',
    '[aria-label="Close ad" i]'
  ];

  // --- event.isTrusted override ---
  // YouTube checks event.isTrusted on ad-skip button clicks.  Synthetic
  // clicks (.click(), dispatchEvent) set isTrusted = false and YouTube
  // silently ignores them.  We patch addEventListener on skip-button
  // elements so that the handler receives a Proxy where isTrusted === true.
  // Inspired by yt-ad-autoskipper's overrideEvent.ts.
  function wrapListener(original) {
    return function(event) {
      var proxied = new Proxy(event, {
        get: function(target, prop) {
          if (prop === 'isTrusted') return true;
          var val = target[prop];
          return typeof val === 'function' ? val.bind(target) : val;
        }
      });
      return original.call(this, proxied);
    };
  }

  function patchAddEventListener(el) {
    if (el.__ytTrayPatched) return;
    el.__ytTrayPatched = true;
    var origAdd = el.addEventListener.bind(el);
    el.addEventListener = function(type, listener, opts) {
      if (type === 'click' || type === 'pointerup' || type === 'mouseup') {
        origAdd(type, wrapListener(listener), opts);
      } else {
        origAdd(type, listener, opts);
      }
    };
  }

  // Patch skip buttons as they appear in the DOM
  function patchSkipButtons() {
    for (var i = 0; i < SKIP_SELECTORS.length; i++) {
      var els = document.querySelectorAll(SKIP_SELECTORS[i]);
      for (var j = 0; j < els.length; j++) {
        patchAddEventListener(els[j]);
        // Also patch ancestors (YouTube sometimes binds click on a wrapper)
        var parent = els[j].parentElement;
        for (var k = 0; k < 3 && parent; k++, parent = parent.parentElement) {
          patchAddEventListener(parent);
        }
      }
    }
  }

  // Also install a global override early, so any skip-button listeners
  // registered later also get the isTrusted patch.
  function installGlobalTrustedOverride() {
    if (trustedOverrideInstalled) return;
    trustedOverrideInstalled = true;

    var origProtoAdd = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function(type, listener, opts) {
      // Only patch click/pointer handlers on elements that look like skip buttons
      if ((type === 'click' || type === 'pointerup' || type === 'mouseup') && this instanceof HTMLElement) {
        var el = this;
        var isSkip = false;
        try {
          for (var i = 0; i < SKIP_SELECTORS.length && !isSkip; i++) {
            if (el.matches && el.matches(SKIP_SELECTORS[i])) isSkip = true;
          }
          // Also check if any ancestor 2 levels up matches
          if (!isSkip) {
            var p = el.parentElement;
            for (var k = 0; k < 3 && p && !isSkip; k++, p = p.parentElement) {
              for (var i2 = 0; i2 < SKIP_SELECTORS.length && !isSkip; i2++) {
                if (p.matches && p.matches(SKIP_SELECTORS[i2])) isSkip = true;
              }
            }
          }
        } catch(e) {}
        if (isSkip) {
          return origProtoAdd.call(this, type, wrapListener(listener), opts);
        }
      }
      return origProtoAdd.call(this, type, listener, opts);
    };
    console.log('[YT-Tray Main] Global isTrusted override installed');
  }

  // --- Helpers ---
  function getPlayer() {
    return document.getElementById('movie_player');
  }

  function getVideo() {
    return document.querySelector('video.html5-main-video') ||
           document.querySelector('#movie_player video') ||
           document.querySelector('video');
  }

  function isAd() {
    var player = getPlayer();
    if (!player) return false;
    return player.classList.contains('ad-showing') ||
           player.classList.contains('ad-interrupting');
  }

  function isElVisible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // --- playbackRate interception ---
  function interceptRate(video) {
    if (rateIntercepted && interceptedVideo === video) return;
    releaseRate();

    var desc = null;
    var proto = video;
    while (proto) {
      desc = Object.getOwnPropertyDescriptor(proto, 'playbackRate');
      if (desc && desc.set) break;
      desc = null;
      proto = Object.getPrototypeOf(proto);
    }
    if (!desc) return;

    interceptedVideo = video;
    rateIntercepted = true;
    var origSet = desc.set;
    var origGet = desc.get;

    Object.defineProperty(video, 'playbackRate', {
      configurable: true,
      enumerable: true,
      get: function() { return origGet.call(this); },
      set: function(val) {
        origSet.call(this, adActive ? AD_RATE : val);
      }
    });

    origSet.call(video, AD_RATE);
    console.log('[YT-Tray Main] playbackRate intercepted, forced to ' + AD_RATE + 'x');
  }

  function releaseRate() {
    if (interceptedVideo && rateIntercepted) {
      try { delete interceptedVideo.playbackRate; } catch(e) {}
    }
    rateIntercepted = false;
    interceptedVideo = null;
  }

  // --- YouTube player API ---
  function tryApi() {
    var now = Date.now();
    if (now - lastApiAt < API_COOLDOWN_MS) return;
    lastApiAt = now;

    var player = getPlayer();
    if (!player) return;
    try {
      if (typeof player.skipAd === 'function') {
        player.skipAd();
        console.log('[YT-Tray Main] player.skipAd() called');
      }
    } catch(e) {}
    try {
      if (typeof player.finishAd === 'function') player.finishAd();
    } catch(e) {}
    try {
      var v = getVideo();
      if (v && v.duration && typeof player.seekTo === 'function') {
        player.seekTo(v.duration, true);
      }
    } catch(e) {}
  }

  // --- Seek to end ---
  function seekEnd(video) {
    try {
      var dur = video.duration;
      if (dur && isFinite(dur) && dur > 0 && video.currentTime < dur - 0.3) {
        video.currentTime = dur - 0.1;
      }
    } catch(e) {}
  }

  // --- Click skip button (main world, with isTrusted override) ---
  function clickSkipButton() {
    var now = Date.now();
    if (now - lastSkipAt < SKIP_COOLDOWN_MS) return;

    for (var i = 0; i < SKIP_SELECTORS.length; i++) {
      var btns = document.querySelectorAll(SKIP_SELECTORS[i]);
      for (var j = 0; j < btns.length; j++) {
        if (isElVisible(btns[j])) {
          lastSkipAt = now;
          patchAddEventListener(btns[j]);
          btns[j].click();
          // Also try parent (YouTube sometimes binds on wrapper)
          if (btns[j].parentElement) {
            patchAddEventListener(btns[j].parentElement);
            btns[j].parentElement.click();
          }
          console.log('[YT-Tray Main] Clicked skip: ' + SKIP_SELECTORS[i]);
          return;
        }
      }
    }

    // Text-based fallback during active ads
    if (!adActive) return;
    var all = document.querySelectorAll('button, [role="button"]');
    for (var k = 0; k < all.length; k++) {
      var el = all[k];
      var label = (el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '');
      if (/skip\\s*(ad|ads)|ad\\s*skip/i.test(label) && isElVisible(el)) {
        lastSkipAt = now;
        patchAddEventListener(el);
        el.click();
        console.log('[YT-Tray Main] Clicked skip (text): ' + label.trim().substring(0, 30));
        return;
      }
    }
  }

  // --- Dismiss overlay / banner ads ---
  function dismissOverlays() {
    for (var i = 0; i < OVERLAY_CLOSE_SELECTORS.length; i++) {
      var btn = document.querySelector(OVERLAY_CLOSE_SELECTORS[i]);
      if (btn && isElVisible(btn)) {
        btn.click();
        return;
      }
    }
  }

  // --- Main loop ---
  function tick() {
    var video = getVideo();
    if (!video) return;

    var playing = isAd();

    if (playing && !adActive) {
      adActive = true;
      savedRate = video.playbackRate || 1;
      lastApiAt = 0;
      lastSkipAt = 0;
      console.log('[YT-Tray Main] Ad detected');
    }

    if (playing) {
      interceptRate(video);
      video.playbackRate = AD_RATE;
      seekEnd(video);
      tryApi();
      clickSkipButton();
      dismissOverlays();
      patchSkipButtons();
    } else if (adActive) {
      adActive = false;
      releaseRate();
      try { video.playbackRate = savedRate; } catch(e) {}
      console.log('[YT-Tray Main] Ad ended');
    }
  }

  setInterval(tick, POLL_MS);

  function startObs() {
    if (!document.documentElement) { setTimeout(startObs, 50); return; }
    new MutationObserver(tick).observe(document.documentElement, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['class']
    });
  }
  installGlobalTrustedOverride();
  startObs();
  tick();
  console.log('[YT-Tray Main] Main-world ad skip installed');
})();`;

let tray;
let youtubeWin;
let guestWebContents;
let isQuitting = false;
let flyoutAnimationTimer;
let flyoutAnimationId = 0;
let flyoutCanHideOnBlur = false;
let lastNativeSkipAt = 0;

function isYouTubeAvailable() {
  return youtubeWin && !youtubeWin.isDestroyed();
}

function runInYouTube(source) {
  if (!isYouTubeAvailable() || youtubeWin.webContents.isDestroyed()) return Promise.resolve(false);
  return youtubeWin.webContents.executeJavaScript(source, true).catch(() => false);
}

// YouTube can ignore DOM-created click events on its ad controls. This emits the same
// pointer sequence Chromium receives from a user, constrained to the visible page bounds.
// The coordinates come from inside the webview guest, so the input must be injected into
// the guest's own webContents — sending it to the shell page never reaches YouTube.
ipcMain.on('ad-skip:click-visible-button', (_event, point) => {
  if (!guestWebContents || guestWebContents.isDestroyed()) {
    return;
  }
  if (!isYouTubeAvailable() || !youtubeWin.isVisible()) {
    return;
  }
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
    return;
  }

  // Coordinates come from the guest's own coordinate space (the webview),
  // so we need to validate against the guest's dimensions, not the shell window's.
  const guestSize = guestWebContents.getOwnerBrowserWindow()?.getContentSize();
  if (!guestSize) {
    return;
  }
  
  // Simple sanity check: coordinates should be reasonable (not negative, not absurdly large)
  if (point.x < 0 || point.y < 0 || point.x > 10000 || point.y > 10000) {
    return;
  }

  const now = Date.now();
  if (now - lastNativeSkipAt < 350) {
    return;
  }
  lastNativeSkipAt = now;

  guestWebContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
  guestWebContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  guestWebContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  });

ipcMain.on('ad-skip:loaded', () => {
  });

function getFlyoutBounds() {
  if (!isYouTubeAvailable()) return null;

  // Show on the monitor the cursor is on, so the flyout appears where the user
  // is looking rather than always on the primary display.
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { workArea } = display;
  const [width] = youtubeWin.getSize();
  const usableHeight = workArea.height - FLYOUT_GAP * 2;
  const height = Math.min(
    usableHeight,
    Math.max(MIN_PANEL_HEIGHT, Math.round(workArea.height * PANEL_HEIGHT_RATIO))
  );
  return {
    x: workArea.x + workArea.width - width - FLYOUT_GAP,
    y: workArea.y + workArea.height - height - FLYOUT_GAP,
    width,
    height
  };
}

function stopFlyoutAnimation() {
  flyoutAnimationId += 1;
  if (flyoutAnimationTimer) {
    clearTimeout(flyoutAnimationTimer);
    flyoutAnimationTimer = undefined;
  }
}

function setFlyoutSurface(revealed, animated) {
  return runInYouTube(`(() => {
    const root = document.documentElement;
    root.style.setProperty('--flyout-show-duration', '${FLYOUT_SHOW_DURATION_MS}ms');
    root.style.setProperty('--flyout-hide-duration', '${FLYOUT_HIDE_DURATION_MS}ms');
    root.classList.toggle('flyout-visible', ${revealed});
    root.classList.toggle('flyout-animated', ${animated});
    root.getBoundingClientRect();
    return true;
  })()`);
}

async function animateFlyout(show) {
  if (!isYouTubeAvailable()) return;

  stopFlyoutAnimation();
  flyoutCanHideOnBlur = false;
  const animationId = ++flyoutAnimationId;
  const target = getFlyoutBounds();
  if (!target) return;

  // Keep the native window fixed entirely inside the Windows work area. The
  // GPU-composited web surface moves inside it, avoiding a jittery native move
  // loop and never crossing into the taskbar.
  youtubeWin.setBounds(target);
  if (show) {
    // Park the fully rendered surface below the window edge while it is still
    // invisible, so the first visible frame is empty and the flyout rises out
    // of the taskbar edge like the Windows shell flyouts.
    await setFlyoutSurface(false, false);
    if (animationId !== flyoutAnimationId || !isYouTubeAvailable()) return;
    if (!youtubeWin.isVisible()) youtubeWin.showInactive();
    setFlyoutSurface(true, true);
    // No forced focus here: stealing focus from a fullscreen app is what kicks
    // it out of fullscreen. The window takes focus on the first click, and the
    // 'focus' listener arms blur-to-hide only once focus is real.
  } else {
    setFlyoutSurface(false, true);
    flyoutAnimationTimer = setTimeout(() => {
      if (animationId !== flyoutAnimationId || !isYouTubeAvailable()) return;
      flyoutAnimationTimer = undefined;
      youtubeWin.hide();
    }, FLYOUT_HIDE_DURATION_MS);
  }
}

function showYouTube() {
  if (!isYouTubeAvailable()) return;
  if (!youtubeWin.isVisible()) {
    animateFlyout(true);
  } else {
    stopFlyoutAnimation();
    youtubeWin.setBounds(getFlyoutBounds());
    setFlyoutSurface(true, false);
  }
}

function toggleYouTube() {
  if (!isYouTubeAvailable()) return;
  if (youtubeWin.isVisible()) {
    animateFlyout(false);
  } else {
    showYouTube();
  }
}

function createYouTubeWindow() {
  youtubeWin = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: 360,
    minHeight: MIN_PANEL_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: 'YouTube',
    webPreferences: {
      // The ad observer retains normal timing while the window is hidden to the tray.
      backgroundThrottling: false,
      // The local shell owns the animation; its guest loads the real YouTube page.
      preload: path.join(__dirname, 'shell-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true
    }
  });

  youtubeWin.loadFile('shell.html');

  // 'screen-saver' is the strongest always-on-top level: it keeps the flyout
  // above borderless-fullscreen games and videos instead of behind them.
  youtubeWin.setAlwaysOnTop(true, 'screen-saver', 1);

  youtubeWin.webContents.on('did-attach-webview', (_event, webContents) => {
    guestWebContents = webContents;

    // Inject the main-world ad-skip script into the YouTube guest page.
    // executeJavaScript runs in the page's main world (not the preload's
    // isolated world), so it can access YouTube's player API and override
    // property descriptors that YouTube's own code will hit.
    const injectMainWorldAdSkip = () => {
      if (webContents.isDestroyed()) return;
      webContents.executeJavaScript(MAIN_WORLD_AD_SKIP).catch(() => {});
    };
    webContents.on('dom-ready', injectMainWorldAdSkip);
  });

  youtubeWin.on('focus', () => {
    // Blur-to-hide is armed by real focus, never assumed: a flyout shown
    // inactive over a fullscreen app must not flash-hide on a phantom blur.
    if (!isQuitting) flyoutCanHideOnBlur = true;
  });

  youtubeWin.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      youtubeWin.hide();
    }
  });
  youtubeWin.on('blur', () => {
    if (!isQuitting && flyoutCanHideOnBlur && youtubeWin.isVisible()) animateFlyout(false);
  });

  youtubeWin.once('ready-to-show', () => {
    showYouTube();
  });
}

function getAutostartEnabled() {
  return app.getLoginItemSettings().openAtLogin;
}

function setAutostartEnabled(enabled) {
  const settings = { openAtLogin: enabled };
  if (!app.isPackaged) {
    settings.path = process.execPath;
    settings.args = [path.resolve(process.argv[1])];
  }
  app.setLoginItemSettings(settings);
}

function createTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: youtubeWin?.isVisible() ? 'Hide YouTube  (Alt+`)' : 'Show YouTube  (Alt+`)',
      click: toggleYouTube
    },
    { type: 'separator' },
    {
      label: 'Launch at sign-in',
      type: 'checkbox',
      checked: getAutostartEnabled(),
      click: (item) => setAutostartEnabled(item.checked)
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]);
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip('YouTube');
  tray.on('click', toggleYouTube);
  tray.on('right-click', () => tray.popUpContextMenu(createTrayMenu()));
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', showYouTube);
  app.on('before-quit', () => {
    isQuitting = true;
  });
  app.on('will-quit', () => {
    globalShortcut.unregister(TOGGLE_SHORTCUT);
  });
  app.on('window-all-closed', () => {});

  app.whenReady().then(() => {
    app.setAppUserModelId('com.youtube.tray');
    createYouTubeWindow();
    createTray();
    globalShortcut.register(TOGGLE_SHORTCUT, toggleYouTube);
    app.on('activate', showYouTube);
  });
}

