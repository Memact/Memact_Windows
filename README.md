# Memact

Memact is the website and browser-memory app for Memact.

The website runs at `https://www.memact.com`. On desktop Chromium browsers, the optional Memact extension captures browser memories locally and makes them searchable from the site. On phone browsers, the website still works in local web mode.

## What It Does

- Hosts the Memact web interface
- Searches local browser memories from the Memact site
- Supports desktop extension capture with local storage only
- Supports phone-browser local web mode
- Uses capture intent and clutter audit modules to avoid low-value captures

## Privacy

- Everything stays local by default
- No cloud APIs
- No remote AI calls
- No screenshots or keystroke capture

## Project Layout

- `src/` - React website app
- `extension/memact/` - browser extension
- `public/` - static website assets
- `assets/` - fonts and shared visual assets
- `memact_branding/` - brand logos and icons

## Run Locally

```powershell
npm install
npm run dev
```

To create a production build:

```powershell
npm run build
```

## Load The Extension

Use the website menu item `Install Browser Extension` for the manual setup popup. It now shows the same steps inside Memact.

Manual flow:

1. Open `chrome://extensions`, `edge://extensions`, `brave://extensions`, `opera://extensions`, or `vivaldi://extensions`
2. Turn on Developer mode
3. Click `Load unpacked`
4. Select `extension/memact`
5. Reload the extension after code changes

Clicking the extension icon opens `https://www.memact.com`.

## Local Development Hosts

The extension can connect to:

- `http://localhost`
- `http://127.0.0.1`
- `http://0.0.0.0`
- `https://www.memact.com`

## Website Readiness

- Website metadata points to `https://www.memact.com`
- The extension action opens `https://www.memact.com`
- Old unused landing-page files have been removed from the repo
- The repository now contains the website and extension code only

## License

See `LICENSE`.
