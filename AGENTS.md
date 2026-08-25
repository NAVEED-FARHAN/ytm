# AGENTS.md

## What this is

YouTube Tray: a Windows-only Electron app that hosts the real youtube.com in a compact frameless flyout window anchored to the bottom-right of the screen, toggled from the system tray or `Alt+`` `. Plain CommonJS, no bundler, no TypeScript, no ESLint, no test suite.

## Commands

- `npm start` (or `npm run dev`) — launch the app (`electron .`)
- `npm run check` — syntax-check with `node --check`. This is the only verification command; it enumerates files explicitly (`main.js`, `ad-skip.js`, `shell-preload.js`, `shell.js`), so add any new top-level JS file to this script.
- `npm run dist` — build the Windows NSIS installer into `dist/` (gitignored)

## Architecture: three execution contexts

Data flows strictly main → shell → guest. Do not blur these boundaries.

1. **Main process (`main.js`)** — tray, single-instance lock, `Alt+`` global shortcut, flyout show/hide animation, autostart via `app.setLoginItemSettings`, and the `ad-skip:click-visible-button` IPC handler which replays trusted native mouse input (`webContents.sendInputEvent`) at guest-supplied coordinates, bounds-checked against the content size and rate-limited to 350 ms. The input must be injected into the guest webContents (captured via `did-attach-webview`), not the shell's — synthetic input to the shell page never reaches the webview.
2. **Shell page (`shell.html` / `shell.css` / `shell.js`)** — a local page loaded by the BrowserWindow, containing `#flyout-surface` with a `<webview id="youtube-page">`. `shell-preload.js` is its contextBridge preload (contextIsolation on, nodeIntegration off); its only job is exposing the file URL of `ad-skip.js`.
3. **Guest page (`ad-skip.js`)** — injected into the webview as its document-start preload. Mutes the video during detected in-stream ads, restores saved volume/mute state afterward, and clicks YouTube's own visible skip button (via the main-process IPC above, because YouTube ignores DOM `HTMLElement.click()` on ad controls). It never intercepts or blocks network requests.

## Gotchas

- **Preload-before-src ordering:** `shell.js` must set the webview's `preload` attribute *before* assigning `src`, so the ad guard installs before YouTube renders its first player/ad element.
- **Session persistence:** the webview uses `partition="persist:youtube"` so Google login survives restarts. Don't change it casually.
- **Flyout animation split:** the native window bounds stay inside the Windows work area at all times; the surface itself is parked fully below the window's bottom edge at `opacity: 0` and rises into view (translate + fade, per-direction easing) entirely on the compositor. The duration defaults in `shell.css` `:root` mirror the constants in `main.js` (`FLYOUT_SHOW_DURATION_MS` / `FLYOUT_HIDE_DURATION_MS` → `--flyout-show-duration` / `--flyout-hide-duration`) — keep them in sync.
- **Rounded corners:** the guest page is composited as its own layer and escapes the surface's `border-radius` + `overflow: hidden`, so `#youtube-page` must carry the rounded clip itself (`border-radius` + `clip-path`, both from `--flyout-radius`). Ancestor clipping alone renders square corners.
- **Close = hide:** the window's `close` event is intercepted to hide instead of destroy (`isQuitting` flag); `window-all-closed` intentionally does nothing. Quit only via the tray menu.
- **No throttling:** `backgroundThrottling: false` on both the BrowserWindow and the webview so the ad observer keeps working while hidden in the tray.
- **Selector drift:** YouTube's ad-related class names change periodically. All page-specific selectors are centralized in the `SELECTORS` object at the top of `ad-skip.js`; the text-based fallback (`/skip\s*(ad|ads)|ad\s*skip/i`) must only match while an ad is active.
- **Blur-hide guard:** `flyoutCanHideOnBlur` exists because `showInactive()` can emit a blur as the window becomes visible; only enable blur-to-hide after the flyout finishes and receives focus.
- **Windows-only assumptions:** work-area math, tray behavior, NSIS target, and AppUserModelId (`com.youtube.tray`) all assume Windows.

## Conventions

- Single quotes, 2-space indent, semicolons.
- Guard re-entry with sentinel flags (e.g. `window.__youtubeTrayAdGuardInstalled`, style element ID checks) when injecting into the guest page.
- Comments explain non-obvious constraints (why native input events, why no throttling), not what the code does.
