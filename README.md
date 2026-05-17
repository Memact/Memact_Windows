# Memact Website

Website is the Memact web UI for users and developers.

Memact is permissioned intent infrastructure for apps.
It helps apps predict user intent from approved digital activity while users
choose what each app is allowed to use.

```text
Apps ask for context. Users choose what Memact can understand.
```

This repo owns the public site and the authenticated portal for:

- sign in with email, password, magic link, or GitHub
- app registration
- scoped permission selection
- activity category selection
- API key creation, testing, and revocation
- app consent flow
- Data Transparency controls for reviewing and revoking app access
- account management
- plain-English help
- public pages that explain Memact for search and sharing

Website does not capture activity, infer intent, or read memory graphs directly. It talks to the Supabase-backed access layer that stores apps, permissions, consent records, and API key metadata.

## Product Definition

Memact turns approved digital activity into useful context and intent signals:
what users appear to be doing, what patterns matter, and what each app is
allowed to use.

Website is not the memory engine. It is the account, app, permission, consent, and API key console.

```text
Website -> access layer -> scoped API key -> user consent -> evidence/filtering -> intent and context
```

Apps use Memact for permissioned intent and context. Each app must stay inside
the scopes, categories, consent, and Data Transparency disclosure attached to
that app.

Intent prediction is backend-only by default. After consent, an app backend can
ask Memact for an evidence-backed intent hypothesis using the approved
`connection_id`, required scopes, approved activity categories, and approved
activity. The browser should not run raw prediction over private activity.

## Current UI

The current UI is a minimal dark console built around `#00011B`, IBM Plex Sans,
compact cards, rounded controls, and consistent button hierarchy.

Authenticated dashboard:

- mobile uses a compact top row with the logo and tabs kept close
- desktop uses the same floating header pattern with Dashboard, Account, and Help
- Dashboard shows app registration, permissions, API keys, usage statistics, and the one-time key flow
- `/DataTransparency` is a consent-companion page, not a dashboard tab
- Account shows identity, email/password actions, and account metrics
- Help uses short FAQs for users and developers

Button hierarchy:

```text
Primary: Create API key / Continue / Approve connection
Secondary: Save permissions / New app / Test key / Cancel
Danger: Delete app / Revoke / Sign out
Utility: Copy key / copy tutorial code
```

The UI should stay direct and calm. Avoid generic SaaS filler, fake AI claims,
and decorative copy that does not help someone complete the task.

## Public Pages and Discovery

The site includes crawlable public discovery assets:

- `/` for Memact metadata and app shell
- `/learn/` for a static explanation page
- `/robots.txt`
- `/sitemap.xml`
- `/llms.txt`
- Open Graph and Twitter preview metadata
- JSON-LD for the web app and FAQ content
- PWA manifest basics

`/learn/` explains Memact in standalone sections so Google, Perplexity, and
other search/answer systems can understand the product without needing to run
the authenticated React dashboard.

## Run Locally

Start Website:

```powershell
npm install
npm run dev
```

Open:

```text
http://localhost:3000/
```

Build:

```powershell
npm run build
```

## Configuration

Create `.env`:

```text
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-public-anon-key
# Optional override for non-standard deploy domains. Defaults to the current origin.
# VITE_AUTH_REDIRECT_URL=http://localhost:3000/Dashboard
# Optional override for generated app integration snippets.
# VITE_MEMACT_DEVELOPER_API_URL=https://api.memact.com/v1/access/verify
```

Only use the Supabase anon key in Website. Never put a service role key, GitHub
OAuth client secret, or private database secret in frontend code.

Before the portal works, apply the access-layer SQL migration from:

```text
../Access/supabase/migrations/20260507120000_memact_access.sql
```

In Supabase Auth URL settings, allow the local and production callback URLs:

```text
http://localhost:3000/Dashboard
http://localhost:3000/DataTransparency
http://localhost:3000/Account
http://localhost:3000/connect
https://www.memact.com/Dashboard
https://www.memact.com/DataTransparency
https://www.memact.com/Account
https://www.memact.com/connect
https://www.memact.com/**
```

In Supabase GitHub provider settings, connect the GitHub OAuth App there. The
GitHub OAuth client secret belongs in Supabase, not this repo.

For Render, set:

```text
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-public-anon-key
# Optional: VITE_AUTH_REDIRECT_URL=https://www.memact.com/Dashboard
# Optional: VITE_MEMACT_DEVELOPER_API_URL=https://api.memact.com/v1/access/verify
```

## Render and SEO

`render.yaml` deploys Website as a Render static site.

The current production canonical is:

```text
https://www.memact.com/
```

Google Search Console verification uses a static file under `public/`.

Sitemap submission path:

```text
sitemap.xml
```

Full sitemap URL:

```text
https://www.memact.com/sitemap.xml
```

If Blueprint setup fails, use the direct Dashboard path in
[`RENDER_DIRECT_DEPLOY.md`](./RENDER_DIRECT_DEPLOY.md).

## Current Policy

- Source-available project wording. Do not call core Memact repos open-source unless that repo license says so.
- Free access for now.
- API keys are shown once and should be stored server-side by the app developer.
- App names are unique per account.
- Deleting an app revokes its active API keys and permissions.
- Data Transparency must stay available alongside the consent flow so users can review the evidence fields, context objects, graph packet use, retention, and revocation path before approval.
- Revoked keys remain visible as history.
- Scopes and saved permissions are required before apps can use Memact.
- Activity categories are required before apps can use Memact.
- The consent flow creates user-specific permission for one app.
- Graph read access is separate from evidence use and schema writes.
- Redirect URLs and developer URLs must use `http://` or `https://`; unsafe schemes are rejected or ignored.
- Supabase is the primary access backend. The local HTTP client is only a development fallback.

## App Integration Tutorial

After creating an API key, Website shows:

- a one-time API key
- `Copy key`
- `Test key`
- a beginner-style Connect tutorial
- copy buttons for each tutorial code section

The tutorial is intentionally split into numbered steps instead of one giant code dump:

```text
1. Send the user to the consent page
2. Link the matching Data Transparency page
3. Read the connection id after approval
4. Verify access before doing work
5. Use only approved access
```

Normal app flow:

```text
developer creates app
-> chooses scopes and categories
-> user clicks "Connect Memact" inside the third-party app
-> Memact shows consent plus Data Transparency for that app
-> user approves or cancels
-> approved apps receive a connection_id
-> app verifies API key + connection_id + scopes before requesting context
```

API keys identify the app. `connection_id` identifies the specific user consent.
Verification must pass both.

Memact verifies the API key before an app can use approved evidence, schema, graph, or memory permissions. Customer apps verify through the Memact HTTP endpoint; they do not call Supabase RPCs or configure Supabase keys.

```http
POST https://api.memact.com/v1/access/verify
Authorization: Bearer mka_your_private_app_key
Content-Type: application/json
```

```json
{
  "connection_id": "connection_id_from_connect_redirect",
  "required_scopes": ["memory:read_summary"],
  "activity_categories": ["web:research"]
}
```

The app receives only the context, memory, and graph access allowed by the scopes and activity categories the user approved for that app.

For developer docs and generated coding guidance, keep the integration
explanation practical:

```text
1. Put a "Connect Memact" button in the app.
2. Send users to /connect with app_id, scopes, categories, redirect_uri, and optional state.
3. Link /DataTransparency with the same app_id, scopes, categories, and redirect_uri.
4. Store the returned connection_id for that user.
5. Keep the raw Memact API key on the server.
6. Verify api_key + connection_id + required_scopes + activity_categories through the Memact verification endpoint before requesting context.
7. Use only the approved context, memory, scopes, and categories returned by verification.
```

Do not describe repository names as separate brands. Memact is the brand; access,
capture, schema, and memory are functions or layers.

## Consent and Data Transparency

The consent page must show what the app is asking Memact to understand, what
activity categories it wants, and a Data Transparency link for the same app.

Data Transparency is not an owner-dashboard tab. It is a user-facing companion
page for the app asking for consent. It must explain:

- evidence fields that may inform understanding, such as URLs, page titles, selected text, transcripts, timestamps, or evidence snippets
- memory objects and graph packets, such as summaries, evidence cards, inferred schema packets, nodes, edges, aggregates, or patterns
- why the app needs that context
- retention and deletion expectations
- how the user can revoke consent or stop future access

Categories and scopes are boundaries, not the full disclosure. If an app cannot
describe the evidence and context objects it uses, the consent flow is not
ready.

## Help Tab

Website includes a Help tab for non-technical users. It explains:

- what Memact is
- whether apps receive private data by default
- how consent works
- what activity categories are
- how developers should embed the API safely
- what schema packets are
- what apps should not do

The Help tab should stay short. Long docs belong in `/learn/` or future docs,
not inside the dashboard.

## Backend Notes

Website expects the Supabase access layer to provide these functions for the dashboard and consent UI:

```text
memact_create_app
memact_grant_consent
memact_create_api_key
memact_verify_api_key
memact_revoke_api_key
```

Supabase RPC names and argument names must match exactly. If the schema cache is stale or a function signature changes, Website falls back to browser-safe table paths where possible and shows a clear error where it cannot.

Third-party apps should not use those RPC names directly. They should call the
Memact verification API from their backend with their private `mka_...` key.

## License

See `LICENSE`.
