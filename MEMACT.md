# Memact description

**Permissioned intent infrastructure for apps.**

```text
Understand what users are trying to do.
```

Memact is infrastructure that helps apps predict user intent from approved digital activity, without giving them raw access to a user's private data.

This repo is the Memact web portal for sign in, app registration, permissions, API keys, Connect App consent, Data Transparency, help, SEO, and public learn content.

## System position

```text
Website manages -> Access gates -> Capture records -> Inference understands -> Schema groups -> Intent predicts -> Memory stores -> Apps consume
```

Website is not the capture engine, inference engine, memory store, or intent engine. It is the user and developer-facing control surface for permissioned access.

## What this repo owns

- sign-in and account settings
- app registration and API key management
- permission, category, consent, and Data Transparency UI
- Connect App flow
- help, tutorial, public Learn page, and SEO metadata

## What this repo does not own

- permission verification internals
- browser/page capture
- semantic inference
- schema grouping
- intent prediction rules
- memory storage or retrieval

## Copy rules

Use:

- "Permissioned intent infrastructure for apps."
- "Understand what users are trying to do."
- "approved digital activity"
- "consent and scope boundaries"
- "intent predictions are hypotheses, not facts"

Avoid:

- generic wrapper language
- vague memory-plugin language
- raw-data export framing
- claims that apps receive private data by default
- open-source wording unless the repo license explicitly says so
