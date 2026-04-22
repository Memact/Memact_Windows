# Memact Interface

Version: `v0.0`

Interface is the user-facing Memact app.

Headline:

```text
Cite Your Thoughts.
```

The product is simple:

```text
Enter a thought -> see the sources that may have formed or shaped it.
```

Memact is not a generic search box. It uses the user's own evidence trail: pages, posts, videos, searches, and revisits saved by Capture.

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

The app should stay honest. It shows source candidates and patterns, not proof of causation.

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
