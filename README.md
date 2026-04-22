# Memact Interface

Version: `v0.0`

Interface is the product layer of Memact.

It answers:

`How does the user inspect the evidence behind a thought?`

Memact is being redesigned around a clearer promise:

`Answers with citations from your own digital evidence trail.`

The user enters a thought or question. Interface queries the lower engines and renders a cited answer: possible origin candidates, influence patterns, active schema signals, and the evidence behind each claim.

## Pipeline Position

```text
Capture -> Inference -> Schema -> Interface / Query -> Influence / Origin
```

Interface is the point where the user enters a thought or question. Influence and Origin become meaningful after this query exists.

## Product Meaning

Old Memact was mostly memory search:

```text
Where did I see this?
```

New Memact is citation-backed answering:

```text
What can Memact answer from my evidence trail, and which sources support it?
```

## Engine Map

- `Capture`
  Records observed digital activity.
- `Inference`
  Turns raw activity into canonical themes.
- `Schema`
  Detects repeated mental-frame signals from inferred themes.
- `Interface`
  Accepts the user thought/question and renders the cited answer.
- `Influence`
  Maps repeated shaping patterns, transitions, and source trails.
- `Origin`
  Finds high-precision source candidates that may have introduced the thought.

## Claim Rules

Interface must preserve the distinction between claim types:

- `observed`
  Directly observed evidence.
- `inferred`
  Deterministic theme/meaning derived from captured evidence.
- `schema_signal`
  A repeated possible mental frame, not a diagnosis.
- `influence_pattern`
  A repeated shaping pattern, not a claim that something created the thought.
- `origin_candidate`
  A possible direct source, not proof of causation.

Every claim should link back to evidence.

## Terminal Quickstart

Prerequisites:

- Node.js `20+`
- npm `10+`

Install:

```powershell
npm install
```

Run the local interface:

```powershell
npm run dev
```

Build production assets:

```powershell
npm run build
```

Preview the production build:

```powershell
npm run preview
```

## Current Status

This repo is the current Memact product surface. It is runnable today, but the product direction is moving from memory search toward a citation and answer engine.

The next redesign should make the main user action:

```text
Enter a thought or question -> get an evidence-backed answer with citations
```

## Repository Layout

- `src/`
  Product UI and interaction layer.
- `extension/memact/`
  Website-facing extension bundle used for local setup and packaging.
- `public/`
  Static assets.
- `assets/`
  Fonts and visual assets.
- `scripts/`
  Packaging and local setup helpers.

## License

See `LICENSE`.
