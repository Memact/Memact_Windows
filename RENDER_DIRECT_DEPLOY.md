# Render Direct Deploy

Use this when the Render Blueprint path is not available. The result is still the same Memact Website: a static React app served from Render's CDN.

## 1. Create the Static Site

In Render, create a new Static Site:

```text
Repository: https://github.com/Memact/Website
Branch: main
Name: memact-website
Build Command: npm ci && npm run build
Publish Directory: dist
```

## 2. Environment Variables

Add the public Supabase values used by the browser app:

```text
VITE_SUPABASE_URL=<your Supabase project URL>
VITE_SUPABASE_ANON_KEY=<your Supabase anon key>
VITE_AUTH_REDIRECT_URL=https://www.memact.com/Access
```

Never put a Supabase service role key, GitHub OAuth secret, or database secret in Render environment variables for this static site.

## 3. Rewrite Rule

Add one rewrite rule so direct visits to `/Dashboard`, `/Playground`, `/Wiki`, `/Account`, `/Help`, `/connect`, and old `/DataTransparency` links all load the React app:

```text
Action: Rewrite
Source: /*
Destination: /index.html
```

## 4. Security and Cache Headers

For path `/*`:

```text
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://avatars.githubusercontent.com; connect-src 'self' https://*.supabase.co; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

For path `/assets/*`:

```text
Cache-Control: public, max-age=31536000, immutable
```

For path `/index.html`:

```text
Cache-Control: public, max-age=0, must-revalidate
```

For logo and icon files:

```text
Cache-Control: public, max-age=86400
```

## 5. Domains

Add both custom domains:

```text
memact.com
www.memact.com
```

Then copy the DNS records Render gives you into your domain provider.

## 6. Supabase Redirects

In Supabase Auth URL settings, allow these local and production URLs:

```text
http://localhost:3000/Access
http://localhost:3000/Account
http://localhost:3000/connect
http://localhost:3000/Wiki
https://memact.com/Access
https://memact.com/Account
https://memact.com/connect
https://memact.com/Wiki
https://www.memact.com/Access
https://www.memact.com/Account
https://www.memact.com/connect
https://www.memact.com/Wiki
https://www.memact.com/**
```

If Render gives the Website a `.onrender.com` URL for previews, add the matching `/Dashboard`, `/Playground`, `/Wiki`, `/Account`, and `/connect` URLs too.

For GitHub OAuth, the GitHub callback URL belongs to Supabase:

```text
https://<your-project>.supabase.co/auth/v1/callback
```

## 7. Access Backend

Before testing app registration, permissions, consent, or API keys, apply the access-layer SQL migration:

```text
../Access/supabase/migrations/20260507120000_memact_access.sql
```

That migration gives the Website the Supabase tables and RPCs it needs for app permissions, API keys, consent verification, and connection checks.

## 8. Verify

Open:

```text
https://www.memact.com/
https://www.memact.com/Access
https://www.memact.com/Help
```

Expected behavior:

- `/` loads the public landing page.
- `/Access` asks the user to sign in, then opens the app and API key console.
- `/connect?...` opens the consent flow for a real app request.
- `/Wiki?...` only shows app-specific content when the URL includes a real app consent context.
