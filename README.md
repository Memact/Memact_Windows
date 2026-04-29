# Memact Website

Version: `v0.0`

Memact is a mirror for the virtual cognitive schemas forming from your digital life.

You type a thought.
Memact looks at what you read, watch, search, and revisit.
Then it shows the repeated frames, sources, origins, and influences that may be shaping it.

Why this matters:

- it can help you catch one-sided thinking
- it can help you make better decisions
- it can help you understand why some thoughts or feelings keep showing up
- it can help you explain your ideas more clearly

## How Memact Works

```text
Capture -> Inference -> Schema -> Memory -> Website / Query -> Influence / Origin
```

- `Capture`
  Saves useful activity from your device.
- `Inference`
  Finds the main meaning in that activity.
- `Schema`
  Forms virtual cognitive schemas from repeated meaningful activity.
- `Memory`
  Stores the schema packets that should survive, exposes CRUD, and builds RAG context for answers.
- `Website`
  Lets you type a thought and see the result.
- `Influence`
  Shows what may have shaped the thought over time.
- `Origin`
  Shows what may have first introduced the thought.

## Infrastructure Contract

Website is only one Memact client.
The same backend shape should also work for Android and later API explanations.

The shared contract lives here:

```text
docs/platform-contract.md
```

The important rule is simple:
Memact first filters captured activity into meaningful packets through Inference.
Memory stores potential cognitive schemas as virtual schema memories.
Query retrieval starts from those virtual cognitive schemas, then uses activity/source packets as evidence.
Website receives a `memact.rag_context` from Memory before any optional Gemini answer.
That RAG context is small by design: cognitive-schema memories first, supporting memories second, relation trails third, sources attached only as evidence.
Dynamic memory actions reinforce, weaken, link, or forget those schema memories over time, closer to how mental frames change with repeated experience.
Schema, Origin, and Influence work from retained memory instead of raw browsing noise.
Gemini can answer from a small evidence packet, but the evidence must already come from deterministic Memact engines.
Memact sends only the query, selected schema/origin/influence signals, and a few source summaries, not the full Capture snapshot.

The Website contract carries Memory's `memory_lanes` and `relation_trails` to the server. That means cloud explanation can say why a schema is relevant without receiving the user's full activity history.

Memory is storage-agnostic. Today Website uses local/extension state. Later, the same Memory repository interface can load/save through Google Drive, Supabase, S3, or encrypted user-owned storage without changing the Website query contract.

Website listens for Capture's lightweight Memory Pulse before refreshing local knowledge.
The pulse only says that memory changed; it does not contain captured page content.
That means Website does not keep downloading captured memory when nothing changed.
Search still talks to Capture directly, and Capture ranks results with deterministic local embeddings.
Capture keeps collecting automatically through the extension bridge; it no longer relies on repeated snapshot downloads.
Gemini is not cut off by a short client/server timer; if it is slow, the deterministic answer remains visible while the cloud answer is optional polish.

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
- Settings shows whether Capture is installed.
- Settings shows whether browser activity was imported.
- Settings can clear only browser-imported memories without clearing future captured activity.
- If the user changes their mind later, Settings lets them turn browser import on.

Website does not keep its own extension source code.
Capture is the only extension codebase.
Website only serves the packaged zip that comes from Capture.

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

## Gemini Answer Layer

Memact can use Gemini 2.5 Flash for short answers after local evidence selection.
The default mode is `fallback`, which keeps Memact's deterministic answer as the main path and only asks Gemini when there is real evidence but the local wording is weak.
The browser does not receive the Gemini API key.
The browser sends a minimal evidence packet to the Memact server endpoint, and that server calls Gemini.

Create `.env` from `.env.example` and replace the placeholder:

```powershell
Copy-Item .env.example .env
notepad .env
```

Run the Vite UI:

```powershell
npm run dev
```

Run the API/server in another terminal:

```powershell
npm run api
```

For a single production-style local server:

```powershell
npm run build
npm run serve
```

If `VITE_MEMACT_GEMINI_ENDPOINT` is not set, Memact still works with deterministic answers and sources.

If the extension bridge or Gemini endpoint is slow, Website falls back to Memact's deterministic local pipeline.
It should show an honest no-source state instead of a generic failed-search message.

AI modes:

- `VITE_MEMACT_AI_MODE=fallback`
  Default. Use Gemini only when deterministic evidence exists but local wording is weak.
- `VITE_MEMACT_AI_MODE=assistive`
  Allow Gemini to polish short answers from selected evidence more often.
- `VITE_MEMACT_AI_MODE=off`
  Never call Gemini. Memact still works from Capture, Inference, Schema, Memory, Origin, and Influence.

Server safety:

- `GEMINI_API_KEY` must stay in Render or local `.env`, never in browser code.
- `MEMACT_ALLOWED_ORIGINS` controls which sites can call the Gemini endpoint.
- `MEMACT_RATE_LIMIT_WINDOW_MS` and `MEMACT_RATE_LIMIT_MAX_REQUESTS` control per-client request limits.
- `MEMACT_MAX_QUERY_LENGTH` caps thought/query size before cloud explanation.
- The server accepts JSON requests only and sends Gemini only the selected evidence packet, not the full Capture snapshot.

## Extension Zip

Build the extension in Capture first:

```powershell
cd ..\capture
npm install
npm run package-extension
```

Then sync that packaged zip into Website:

```powershell
cd ..\interface
npm run sync-capture-zip
```

The website then serves that same packaged zip here:

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
- [Memory](https://github.com/Memact/Memory)
- [Schema](https://github.com/Memact/Schema)
- [Origin](https://github.com/Memact/Origin)
- [Influence](https://github.com/Memact/Influence)
- [Website](https://github.com/Memact/Website)

## License

See `LICENSE`.
