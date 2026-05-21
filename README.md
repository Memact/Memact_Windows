# Memact Website

Website is the public site and portal for Memact.

Memact helps apps personalize better using what users choose to share.

```text
Personalization made better
with Memact
```

## What This Repo Owns

- Landing page and SEO assets.
- Sign in and account settings.
- App registration.
- API keys.
- Consent screens.
- Data Transparency.
- Capture Sources UI.
- Features/Studio UI.
- Schemas UI.
- Developer integration docs.
- Help and Learn pages.

## What This Repo Does Not Own

- Access checks, API key verification, or database RPC internals.
- Browser/page capture.
- Semantic inference.
- Schema packet formation.
- Durable memory storage.
- Feature runtime logic.

## Product Flow

```text
Website manages
-> Access checks
-> Capture receives
-> Inference understands
-> Schema organizes
-> Memory stores
-> Studio features run
-> Apps and users use results
```

Website is the console for users and developers. It is not part of the core
capture, inference, schema, memory, or feature pipeline.

## Current UI

The current UI is a minimal dark console built around `#00011B`, IBM Plex Sans,
compact cards, rounded controls, and consistent button hierarchy.

Authenticated dashboard:

- Dashboard shows apps, permissions, API keys, usage statistics, capture sources, features, and schemas.
- `/DataTransparency` is a consent companion page, not a dashboard tab.
- Account shows identity, email/password actions, invites, and account metrics.
- Help uses short FAQs for users and developers.

Keep the UI direct and calm. Avoid generic SaaS filler and decorative copy that
does not help someone complete the task.

## Public Pages and Discovery

The site includes crawlable public discovery assets:

- `/`
- `/learn/`
- `/robots.txt`
- `/sitemap.xml`
- `/llms.txt`
- Open Graph and Twitter preview metadata
- JSON-LD for the web app
- PWA manifest basics

## Run Locally

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
```

Only use the Supabase anon key in Website. Never put a service role key, GitHub
OAuth client secret, or private database secret in frontend code.

Before the portal works, apply the access-layer SQL migration from Access.

## App Integration Tutorial

After creating an API key, Website shows:

- a one-time API key
- copy and test controls
- a Connect Memact URL
- a Data Transparency URL
- a server-side SDK example

Normal app flow:

```text
developer creates app
-> chooses scopes and categories
-> user clicks "Connect Memact" inside the third-party app
-> Memact shows consent plus Data Transparency for that app
-> user approves or cancels
-> approved apps receive a connection_id
-> app verifies API key + connection_id + scopes before sending events or running features
```

API keys identify the app. `connection_id` identifies the specific user consent.
Verification must pass both.

Customer apps should use the Memact SDK/API from their backend. They should not
call Supabase RPCs or configure Supabase keys.

## Consent and Data Transparency

The consent page must show what the app is asking to use and a Data Transparency
link for the same app.

Data Transparency explains:

- what the app can send
- what Memact may create
- why the app wants it
- what features the app may use
- how long access lasts
- how the user can stop future access

Categories and scopes are boundaries, not the full disclosure. If an app cannot
describe what it uses, the consent flow is not ready.

## License

See `LICENSE`.
