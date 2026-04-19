# Memact Interface

Version: `v0.0`

Interface is the product layer of Memact.

It answers:

`How does the user inspect the evidence behind a thought?`

Memact is being redesigned around a clearer promise:

`Citation, but for your thoughts.`

The user enters a thought. Interface will query the lower engines and render a cited Thought Trace: possible origin candidates, influence patterns, active schema signals, and the evidence behind each claim.

## Pipeline Position

```text
Capture -> Inference -> Schema -> Interface / Query -> Origin + Influence
```

Interface is the point where the user enters a thought query. Origin and Influence become meaningful after this query exists.

## Product Meaning

Old Memact was mostly memory search:

```text
Where did I see this?
```

New Memact is thought citation:

```text
What may have introduced this thought, and what may have shaped it over time?
```

## Engine Map

- `Capture`
  Records observed digital activity.
- `Inference`
  Turns raw activity into canonical themes.
- `Schema`
  Detects repeated mental-frame signals from inferred themes.
- `Interface`
  Accepts the user thought and renders the Thought Trace.
- `Origin`
  Finds high-precision source candidates that may have introduced the thought.
- `Influence`
  Maps repeated shaping patterns, transitions, and source trails.

## Claim Rules

Interface must preserve the distinction between claim types:

- `observed`
  Directly captured activity.
- `inferred`
  Deterministic theme/meaning derived from captured evidence.
- `schema_signal`
  A repeated possible mental frame, not a diagnosis.
- `origin_candidate`
  A possible direct source, not proof of causation.
- `influence_pattern`
  A repeated shaping pattern, not a claim that something created the thought.

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

This repo is the current Memact product surface. It is runnable today, but the product direction is moving from memory search toward Thought Trace.

The next redesign should make the main user action:

```text
Enter a thought -> get cited origin/influence evidence
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
