# Memact Platform Contract

Version: `0.1.0`

This contract keeps Memact usable beyond the website.
Website, Android, and future APIs should all use the same evidence shapes.

## Flow

```text
Capture -> Inference -> Schema -> Website Client -> Influence / Origin -> Explanation
```

The Website client is only one surface.
Android should become another surface over the same contracts.
An API explanation layer may produce the short answer, but only from evidence that deterministic engines already selected.

## Runtime Context

`memact.runtime_context` describes the client and what it can do.

```json
{
  "contract": "memact.runtime_context",
  "version": "0.1.0",
  "surface": "website",
  "mode": "extension",
  "platform": {
    "mobile": false,
    "extension_capable": true,
    "standalone": false
  },
  "capabilities": {
    "local_capture": true,
    "local_web_memory": false,
    "android_client_ready": true,
    "api_explanation_ready": true,
    "deterministic_evidence_required": true
  }
}
```

Android can use the same shape with:

```json
{
  "surface": "android",
  "mode": "native-capture"
}
```

## Knowledge Envelope

`memact.knowledge_envelope` is the shared knowledge object kept on the client side.
It keeps raw evidence and derived layers together without hiding what came from where.

```json
{
  "contract": "memact.knowledge_envelope",
  "version": "0.1.0",
  "source": {
    "system": "capture",
    "schema_version": 1
  },
  "snapshot": {},
  "inference": {},
  "schema": {},
  "influence": {},
  "suggestionSeed": [],
  "stats": {
    "eventCount": 0,
    "activityCount": 0,
    "sessionCount": 0,
    "schemaCount": 0,
    "influenceCount": 0
  }
}
```

Rules:

- `snapshot` must come from Capture's public snapshot contract.
- `inference`, `schema`, and `influence` must be deterministic outputs.
- No client should read Capture internals directly.
- No explanation layer should invent sources.

## Thought Explanation

`memact.thought_explanation` is the deterministic answer object for a user thought.

```json
{
  "contract": "memact.thought_explanation",
  "version": "0.1.0",
  "query": "I need to prove myself",
  "deterministic": true,
  "answer": {},
  "origin": {},
  "relevantSchemas": [],
  "relevantInfluence": [],
  "apiExplanationRequest": {}
}
```

The visible product can render `answer`.
An API can consume `apiExplanationRequest` for a short Gemini answer without receiving the full Capture snapshot.

## API Explanation Request

`memact.api_explanation_request` is the minimal cloud packet for hosted explanation.

```json
{
  "contract": "memact.api_explanation_request",
  "version": "0.1.0",
  "query": "I need to prove myself",
  "policy": {
    "ai_role": "short_answer_from_minimal_schema_packet",
    "deterministic_reasoning_done": true,
    "cloud_payload_minimized": true,
    "must_not_invent_sources": true,
    "must_not_claim_causality": true,
    "must_preserve_uncertainty": true
  },
  "deterministic_answer": {},
  "evidence": {
    "origin_sources": [],
    "schema_signals": [],
    "influence_signals": []
  },
  "stats": {}
}
```

Gemini can write the short answer only after deterministic evidence exists.
The API receives selected origin sources, schema signals, influence signals, counts, and compact source summaries.
It must not receive the full Capture snapshot, full page text, screenshots, or unrelated activity.
If evidence is weak, the API must say that plainly.

## Android Readiness

Android should not copy Website logic.
It should implement or call these same boundaries:

- Capture-like native source creates the Capture snapshot shape.
- Deterministic engines consume the snapshot.
- Client stores `memact.knowledge_envelope`.
- Search/query returns `memact.thought_explanation`.
- Optional API receives only `memact.api_explanation_request`.

This keeps Website, Android, and API output aligned.

## Sync Boundary

Clients should not pull the full Capture snapshot on every screen load.
Capture exposes a lightweight `memorySignature` in status.
Website and future clients should only request a full snapshot when that signature changes.

```json
{
  "eventCount": 120,
  "sessionCount": 18,
  "lastEventAt": "2026-04-25T05:00:00.000Z",
  "memorySignature": "120|18|2026-04-25T05:00:00.000Z|complete|2026-04-25T04:58:00.000Z|54"
}
```

This keeps the UI fast, avoids repeatedly transferring captured data, and gives Android/API clients the same clean sync strategy.
Automatic capture should use status signatures and bridge/API reads, not repeated downloaded snapshot files.

## Graph Health Pattern

Memact borrows one useful infrastructure pattern from local wiki systems:
separate deterministic graph health from cloud answer generation.

- cache by stable signatures or hashes
- rebuild only changed knowledge
- keep explicit edges separate from inferred edges
- run structural checks without Gemini
- let Gemini answer only after evidence is fixed and minimized
