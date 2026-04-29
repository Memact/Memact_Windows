# Memact Platform Contract

Version: `0.1.0`

This contract keeps Memact usable beyond the website.
Website, Android, and future APIs should all use the same evidence shapes.

## Flow

```text
Capture -> Inference -> Schema -> Memory -> Website Client -> Influence / Origin -> Explanation
```

The Website client is only one surface.
Android should become another surface over the same contracts.
An API explanation layer may produce the short answer, but only from Memory's RAG context: virtual cognitive-schema memory first, supporting memories second, relation trails third, and selected source evidence only.

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
  "memory": {},
  "influence": {},
  "suggestionSeed": [],
  "stats": {
    "eventCount": 0,
    "activityCount": 0,
    "sessionCount": 0,
    "schemaCount": 0,
    "memoryCount": 0,
    "influenceCount": 0
  }
}
```

Rules:

- `snapshot` must come from Capture's public snapshot contract.
- `inference`, `schema`, `memory`, and `influence` must be deterministic outputs.
- Retrieval should start from `cognitive_schema_memory`, then use source/origin/influence evidence as support.
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
  "relevantCognitiveSchemas": [],
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
    "cognitive_schema_memories": [],
    "rag_context": {
      "contract": "memact.rag_context",
      "retrieval_steps": [],
      "memory_lanes": {
        "cognitive_schema": [],
        "activity": [],
        "relation": []
      },
      "relation_trails": [],
      "context_items": [],
      "sources": []
    },
    "influence_signals": []
  },
  "stats": {}
}
```

Gemini can write the short answer only after deterministic evidence exists.
The API receives selected cognitive-schema memories, origin sources, schema signals, influence signals, counts, and compact source summaries.
It must not receive the full Capture snapshot, full page text, screenshots, or unrelated activity.
If evidence is weak, the API must say that plainly.

## Memory Storage Boundary

Memory is storage-agnostic. Clients can load/save the same memory store from local files, extension storage, Google Drive, Supabase, S3, or another user-controlled backend through the Memory repository adapter.

Storage connectors must follow three rules:

- use Memory CRUD instead of rewriting memory objects directly
- preserve provenance, actions, and graph links
- build `memact.rag_context` before sending anything to a cloud model

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
