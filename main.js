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
  if (!guestWebContents || guestWebContents.isDestroyed()) return;
  if (!isYouTubeAvailable() || !youtubeWin.isVisible()) return;
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return;

  const [width, height] = youtubeWin.getContentSize();
  if (point.x < 0 || point.y < 0 || point.x >= width || point.y >= height) return;

  const now = Date.now();
  if (now - lastNativeSkipAt < 350) return;
  lastNativeSkipAt = now;

  guestWebContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
  guestWebContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  guestWebContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
});

function getFlyoutBounds() {
  if (!isYouTubeAvailable()) return null;

  const { workArea } = screen.getPrimaryDisplay();
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

    flyoutAnimationTimer = setTimeout(() => {
      if (animationId !== flyoutAnimationId || !isYouTubeAvailable()) return;
      flyoutAnimationTimer = undefined;
      youtubeWin.focus();
      // showInactive can emit a blur event as it becomes visible. Only hide
      // after focus has been intentionally given to the completed flyout.
      flyoutCanHideOnBlur = true;
    }, FLYOUT_SHOW_DURATION_MS);
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
    youtubeWin.focus();
    flyoutCanHideOnBlur = true;
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

  youtubeWin.webContents.on('did-attach-webview', (_event, webContents) => {
    guestWebContents = webContents;
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
