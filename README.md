# YouTube Tray

A compact Windows Electron browser for the real YouTube website. It opens as a narrow, frameless window like the reference: the normal YouTube homepage, sign-in flow, feed, Shorts, search, and video player all remain YouTube's own interface.

## Run locally

```powershell
npm install
npm start
```

Sign in normally from YouTube. The browser session uses Electron's `persist:youtube` partition, so the Google login survives restarts. Click the tray icon to hide/show the YouTube window. Closing the window hides it; choose **Quit** from the tray menu to exit the app.

The injected page script immediately silences the media element during detected in-stream ads and clicks YouTube's own visible Skip Ad control when it becomes available. It does not intercept or block network requests. Page-specific selectors are centralized at the top of [`ad-skip.js`](ad-skip.js) for maintenance if YouTube changes its DOM.

## Package for Windows

```powershell
npm run dist
```

The NSIS installer is written to `dist/`. The tray's **Launch at sign-in** menu item uses Electron's Windows login-item setting.
