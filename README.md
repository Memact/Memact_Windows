# Memact Website

Version: `v0.0`

Website is the user-facing Memact product surface.

Tagline:

```text
Connect the Dots.
```

The product is simple:

```text
Enter a thought -> see how it connects with what you read, watch, search, and revisit.
```

Memact is for understanding where thoughts are being formed, shaped, reinforced, or narrowed by digital activity.

The point is practical, not abstract. Memact helps with:

- spotting one-sided thinking and hidden bias before acting on it
- making better decisions with source-backed context
- understanding feelings around thoughts that may have been externally influenced
- supporting mental health by surfacing repeated shaping patterns instead of leaving them invisible
- communicating ideas more clearly because the user can inspect where those ideas came from

## How It Works

```text
Capture -> Inference -> Schema -> Interface -> Influence / Origin
```

- `Capture` saves useful digital activity.
- `Inference` turns that activity into cleaner meaning.
- `Schema` notices repeated themes.
- `Interface` lets the user enter a thought.
- `Influence` shows what may have shaped the thought over time.
- `Origin` finds possible source candidates that may have introduced it.

Memact stays grounded in captured evidence. It shows source-backed patterns, not certainty theatre.

## First-Use Bootstrap

When Capture connects for the first time, Memact can ask permission to inspect a limited slice of recent browser activity so the system does not start empty.

- `Capture` imports recent browser history locally on-device.
- `Inference` turns that early activity into deterministic themes.
- `Schema` marks pattern strength as `emerging`, `reinforced`, or `stable`.
- `Influence` checks for repeated directional movement in those early activities.
- `Origin` is then used per thought query to find direct source candidates.

If the user declines the import prompt, Memact simply starts from future captured activity.

Early patterns are provisional. Memact upgrades them as richer live capture replaces bootstrap-only evidence.

## Local OCR Policy

Capture first uses normal page text, structured page regions, and PDF extraction. Local OCR is only a fallback when a page has weak extractable text.

- It runs locally in the browser when the platform exposes a local text detector.
- It does not upload screenshots or OCR text to an external service.
- It is gated by idle state, weak-text checks, and per-URL cooldowns to reduce battery impact.
- It stores OCR output only as part of the same local event record used by Memact search.

## Run Locally

Prerequisites:

- Node.js `20+`
- npm `10+`

Install:

```powershell
npm install
```

Run:

```powershell
npm run dev
```

Build:

```powershell
npm run build
```

Preview:

```powershell
npm run preview
```

## Install Capture Extension

If the website opens without Capture, it will show an install popup first.

The same extension zip used by that popup is available here:

```text
public/memact-extension.zip
```

Load it like this:

1. Download `memact-extension.zip`.
2. Extract the zip into a folder.
3. Open `chrome://extensions` or `edge://extensions`.
4. Turn on Developer Mode.
5. Click `Load unpacked`.
6. Select the extracted folder.

After Capture is installed, Memact will ask whether it should import a limited local slice of recent browser activity. If that is declined, only future activity is used.

## Search And Indexing

The website now ships with the usual Google-facing essentials already in place:

- canonical home URL
- `robots.txt`
- `sitemap.xml`
- index/follow directives
- JSON-LD for `Organization`, `WebSite`, `WebPage`, and `WebApplication`
- Open Graph and Twitter card metadata
- site manifest and favicon assets
- homepage copy aligned with Memact's actual product purpose

One step still requires the real site owner account: actual Google Search Console property verification. That token or verification HTML file must come from Search Console itself.

After verification, the normal next steps are:

1. Submit `https://www.memact.com/sitemap.xml` in Search Console.
2. Inspect `https://www.memact.com/` in URL Inspection.
3. Request indexing for the homepage if needed.
4. Re-run inspection after major homepage updates.

This follows Google Search Central guidance around sitemaps, canonical URLs, robots directives, structured data, and URL inspection.

## Memact Stack At A Glance

- `Capture`
  Browser extension and evidence layer. Captures useful local digital activity.
- `Inference`
  Converts raw captured activity into deterministic meaning and themes.
- `Schema`
  Detects repeated mental-pattern signals such as emerging or reinforced schemas.
- `Origin`
  Finds possible direct source candidates that may have introduced a thought.
- `Influence`
  Finds repeated directional patterns showing what may have shaped a thought over time.
- `Website`
  The product surface where users type thoughts, inspect sources, install Capture, and review suggestions.

Repositories:

- [Capture](https://github.com/Memact/Capture)
- [Inference](https://github.com/Memact/Inference)
- [Schema](https://github.com/Memact/Schema)
- [Origin](https://github.com/Memact/Origin)
- [Influence](https://github.com/Memact/Influence)
- [Website](https://github.com/Memact/Website)

## Repository Layout

- `src/`
  Product UI and interaction layer.
- `extension/memact/`
  Browser extension bundle used for local setup and packaging.
- `public/`
  Static assets.
- `assets/`
  Fonts and visual assets.
- `scripts/`
  Packaging and setup helpers.

## License

See `LICENSE`.
