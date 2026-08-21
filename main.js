const { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, screen, Tray } = require('electron');
const path = require('path');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const iconPath = path.join(__dirname, 'assets', 'icon.svg');
const WINDOW_WIDTH = 410;
const WINDOW_HEIGHT = 760;
const FLYOUT_GAP = 12;
const FLYOUT_TRAVEL = 36;
const FLYOUT_DURATION_MS = 190;
const TOGGLE_SHORTCUT = 'Alt+`';
const PANEL_HEIGHT_RATIO = 0.7;
const MIN_PANEL_HEIGHT = 480;

let tray;
let youtubeWin;
let isQuitting = false;
let flyoutAnimationTimer;
let lastNativeSkipAt = 0;

function isYouTubeAvailable() {
  return youtubeWin && !youtubeWin.isDestroyed();
}

function runInYouTube(source) {
  if (!isYouTubeAvailable() || youtubeWin.webContents.isDestroyed()) return;
  youtubeWin.webContents.executeJavaScript(source, true).catch(() => {});
}

// YouTube can ignore DOM-created click events on its ad controls. This emits the same
// pointer sequence Chromium receives from a user, constrained to the visible page bounds.
ipcMain.on('ad-skip:click-visible-button', (_event, point) => {
  if (!isYouTubeAvailable() || !youtubeWin.isVisible()) return;
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return;

  const [width, height] = youtubeWin.getContentSize();
  if (point.x < 0 || point.y < 0 || point.x >= width || point.y >= height) return;

  const now = Date.now();
  if (now - lastNativeSkipAt < 350) return;
  lastNativeSkipAt = now;

  youtubeWin.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
  youtubeWin.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  youtubeWin.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
});

function getFlyoutBounds(horizontalOffset = 0) {
  if (!isYouTubeAvailable()) return null;

  const { workArea } = screen.getPrimaryDisplay();
  const [width] = youtubeWin.getSize();
  const usableHeight = workArea.height - FLYOUT_GAP * 2;
  const height = Math.min(
    usableHeight,
    Math.max(MIN_PANEL_HEIGHT, Math.round(workArea.height * PANEL_HEIGHT_RATIO))
  );
  return {
    x: workArea.x + workArea.width - width - FLYOUT_GAP + horizontalOffset,
    y: workArea.y + workArea.height - height - FLYOUT_GAP,
    width,
    height
  };
}

function stopFlyoutAnimation() {
  if (flyoutAnimationTimer) {
    clearTimeout(flyoutAnimationTimer);
    flyoutAnimationTimer = undefined;
  }
}

function animateFlyout(show) {
  if (!isYouTubeAvailable()) return;

  stopFlyoutAnimation();
  const target = getFlyoutBounds();
  if (!target) return;

  const startX = show ? target.x + FLYOUT_TRAVEL : target.x;
  const endX = show ? target.x : target.x + FLYOUT_TRAVEL;
  const startedAt = Date.now();

  youtubeWin.setBounds({ ...target, x: startX });
  youtubeWin.setOpacity(show ? 0 : 1);
  if (show && !youtubeWin.isVisible()) youtubeWin.show();

  const tick = () => {
    if (!isYouTubeAvailable()) return;

    const elapsed = Date.now() - startedAt;
    const progress = Math.min(elapsed / FLYOUT_DURATION_MS, 1);
    // Fast at the start, then softly settles into its final position.
    const eased = 1 - Math.pow(1 - progress, 3);
    youtubeWin.setPosition(Math.round(startX + (endX - startX) * eased), target.y);
    youtubeWin.setOpacity(show ? eased : 1 - eased);

    if (progress < 1) {
      flyoutAnimationTimer = setTimeout(tick, 16);
      return;
    }

    flyoutAnimationTimer = undefined;
    if (show) {
      youtubeWin.setOpacity(1);
      youtubeWin.focus();
    } else {
      youtubeWin.hide();
      youtubeWin.setOpacity(1);
      youtubeWin.setBounds(target);
    }
  };

  tick();
}

function showYouTube() {
  if (!isYouTubeAvailable()) return;
  if (!youtubeWin.isVisible()) {
    animateFlyout(true);
  } else {
    stopFlyoutAnimation();
    youtubeWin.setBounds(getFlyoutBounds());
    youtubeWin.setOpacity(1);
    youtubeWin.focus();
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

const pagePresentationScript = `(() => {
  const STYLE_ID = 'youtube-tray-page-presentation';
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent =
    'html, body { margin: 0 !important; border: 0; border-radius: 0; background: #0f0f0f !important; scrollbar-width: none !important; }' +
    'html::-webkit-scrollbar, body::-webkit-scrollbar, *::-webkit-scrollbar { width: 0 !important; height: 0 !important; background: transparent !important; }' +
    'ytd-app { border-radius: 0; background: #0f0f0f; scrollbar-width: none !important; }' +
    '#youtube-tray-drag-region { position: fixed; z-index: 2147483647; top: 0; right: 0; left: 0; height: 8px; -webkit-app-region: drag; }';
  document.head.appendChild(style);

  const dragRegion = document.createElement('div');
  dragRegion.id = 'youtube-tray-drag-region';
  document.body.appendChild(dragRegion);
})();`;

function injectPagePresentation() {
  runInYouTube(pagePresentationScript);
}

function createYouTubeWindow() {
  youtubeWin = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: 360,
    minHeight: MIN_PANEL_HEIGHT,
    show: false,
    frame: false,
    transparent: false,
    backgroundColor: '#0f0f0f',
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: 'YouTube',
    webPreferences: {
      // Keeps the signed-in YouTube session after restarts.
      partition: 'persist:youtube',
      // The ad observer retains normal timing while the window is hidden to the tray.
      backgroundThrottling: false,
      // The ad guard runs before each YouTube document begins rendering.
      preload: path.join(__dirname, 'ad-skip.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  youtubeWin.loadURL('https://www.youtube.com');
  youtubeWin.webContents.on('dom-ready', injectPagePresentation);
  youtubeWin.webContents.on('did-finish-load', injectPagePresentation);
  youtubeWin.webContents.on('did-navigate-in-page', injectPagePresentation);

  youtubeWin.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      youtubeWin.hide();
    }
  });
  youtubeWin.on('blur', () => {
    if (!isQuitting && youtubeWin.isVisible()) animateFlyout(false);
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
