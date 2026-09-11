# API Diagnostics

Independent Cloudflare deployment of API diagnostics, connection management, saved results and the pelican animation test.

- App: https://api-diagnostics.xue-yuanhuang.workers.dev
- Source: https://github.com/xueyuanhuang/api-diagnostics (private)
- Google project: `automatic-ace-508307-i7` (API Diagnostics)
- Database: D1 `api-diagnostics`
- Evidence: private R2 bucket `api-diagnostics-evidence`

## Develop and verify

Use Node 24 and pnpm 11.19.0. Run `pnpm install`, `pnpm exec wrangler d1 migrations apply api-diagnostics --local`, and `pnpm dev`. Verify with `pnpm exec tsc --noEmit`, `pnpm test`, and `pnpm build`.

## Deploy

Authenticate using `wrangler login`, then run `pnpm deploy`. The build produces the worker configuration used automatically by Wrangler. Database migrations run before publication. GitHub Actions checks types, tests and the production build on each push; deployment currently runs from the authenticated local CLI.

Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `API_KEY_ENCRYPTION_SECRET` using `wrangler secret put`. The encryption secret must be a base64-encoded random 32-byte value; preserve it across deployments or existing saved keys become unreadable. Never commit secret values.

Register a Google Web application client with this authorized redirect URI:

```
https://api-diagnostics.xue-yuanhuang.workers.dev/auth/google/callback
```

Set the Google audience to production when ready for all users. Only `openid email profile` are requested. The server verifies Google's signed ID token, issuer, audience, nonce, expiry and verified email. A one-use, browser-bound OAuth flow uses PKCE; account sessions are random, hashed in D1, expire in 14 days, and are revoked on sign-out. Cookies are HttpOnly, Secure and SameSite=Lax. Hosting-provider identity headers are never trusted.

For availability monitoring, deploy `scheduler/wrangler.jsonc` and set the same `AVAILABILITY_TRIGGER_SECRET` on both workers. It only checks targets users have explicitly added.

## Storage and migration

Signed-in users' connections and completed animation results are stored in D1/R2, scoped to their Google account. Connection API keys are encrypted. Guests can run one-time tests and download outputs. Navigating between test pages keeps active tests mounted; closing or reloading the browser is not a background-job guarantee.

This is a new deployment with new account identities and storage. Data and secrets from the old ChatGPT-hosted site have not been imported. Earlier browser-only animation saves can be imported by the app when available on the same origin; browser storage on the old domain cannot be read by this domain.

Raw IPv4 URL mapping requires the optional `CF_DNS_API_TOKEN`, `CF_DNS_ZONE_ID`, and `IP_MAPPING_SUFFIX=ip-api.xyhmail.xyz` configuration and is not enabled here yet. Standard public hostname URLs work without it.
