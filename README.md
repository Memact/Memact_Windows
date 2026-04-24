# Memact Website

Version: `v0.0`

Memact helps you see where your thoughts may be coming from.

You type a thought.
Memact looks at what you read, watch, search, and revisit.
Then it shows links that may have shaped that thought.

Why this matters:

- it can help you catch one-sided thinking
- it can help you make better decisions
- it can help you understand why some thoughts or feelings keep showing up
- it can help you explain your ideas more clearly

## How Memact Works

```text
Capture -> Inference -> Schema -> Website -> Influence / Origin
```

- `Capture`
  Saves useful activity from your device.
- `Inference`
  Finds the main meaning in that activity.
- `Schema`
  Notices patterns that keep repeating.
- `Website`
  Lets you type a thought and see the result.
- `Influence`
  Shows what may have shaped the thought over time.
- `Origin`
  Shows what may have first introduced the thought.

## First-Time Setup

Memact does not interrupt the user right away.
Setup starts when the user first tries to use search.

If Capture is not installed yet:

1. Download the extension zip.
2. Unzip it into a folder.
3. Open `chrome://extensions` or `edge://extensions`.
4. Turn on Developer Mode.
5. Click `Load unpacked`.
6. Pick the unzipped folder.

After that, Memact can ask to import some recent activity from this device so it does not start empty.

- If the user allows it, Memact starts building first suggestions.
- If the user skips it, Memact waits for new activity from then on.
- If the user changes their mind later, the `Settings` button lets them turn local import on.

## Run Locally

You need:

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

## Extension Zip

The website serves the same extension zip used in setup here:

```text
public/memact-extension.zip
```

## Search Setup

The website already includes the main Google search basics:

- canonical URL
- `robots.txt`
- `sitemap.xml`
- search metadata
- structured data
- favicon and web manifest

One thing still has to be done by the real site owner:
Google Search Console verification.

After verification, the normal next steps are:

1. Submit `https://www.memact.com/sitemap.xml`
2. Inspect `https://www.memact.com/`
3. Request indexing if needed

## Repositories

- [Capture](https://github.com/Memact/Capture)
- [Inference](https://github.com/Memact/Inference)
- [Schema](https://github.com/Memact/Schema)
- [Origin](https://github.com/Memact/Origin)
- [Influence](https://github.com/Memact/Influence)
- [Website](https://github.com/Memact/Website)

## License

See `LICENSE`.
