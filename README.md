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

The public `GOOGLE_CLIENT_ID` is configured in `wrangler.jsonc`. Set `GOOGLE_CLIENT_SECRET` and `API_KEY_ENCRYPTION_SECRET` using `wrangler secret put`. The encryption secret must be a base64-encoded random 32-byte value; preserve it across deployments or existing saved keys become unreadable. Never commit secret values.

Register a Google Web application client with this authorized redirect URI:

```
https://api-diagnostics.xue-yuanhuang.workers.dev/auth/google/callback
```

The Google audience is in production for all users. Only `openid email profile` are requested. The server verifies Google's signed ID token, issuer, audience, nonce, expiry and verified email. A one-use, browser-bound OAuth flow uses PKCE; account sessions are random, hashed in D1, expire in 14 days, and are revoked on sign-out. Cookies are HttpOnly, Secure and SameSite=Lax. Hosting-provider identity headers are never trusted.

For availability monitoring, deploy `scheduler/wrangler.jsonc` and set the same `AVAILABILITY_TRIGGER_SECRET` on both workers. It only checks targets users have explicitly added.

## Storage and migration

Signed-in users' connections and completed animation results are stored in D1/R2, scoped to their Google account. Connection API keys are encrypted. Guests can run one-time tests and download outputs. Navigating between test pages keeps active tests mounted; closing or reloading the browser is not a background-job guarantee.

This deployment uses Google account identities. The original account is linked only after an authenticated transfer; imported connections are re-encrypted for the new server. Earlier browser-only animation saves can be imported by the app when available on the same origin; browser storage on the old domain cannot be read by this domain.

The existing `ip-api.xyhmail.xyz` mappings are supported in read-only mode: a public DNS lookup must exactly match the supplied public IPv4 address before a test can proceed. No DNS management credential is needed to reuse an existing mapping. New DNS mappings require separate DNS provisioning configuration; standard public hostnames work without it.

## Original account transfer

Google is the default sign-in. `/auth/chatgpt` starts a one-time import from the original website after Google login. The original account must authorize the transfer. The callback binds the source account to the initiating Google account and never silently reassigns a prior account link. API keys travel only over the server-to-server HTTPS exchange and are encrypted with this worker's key. Original profiles remain unchanged. Each profile imports transactionally once; retries preserve new-site edits and deletions.

The original site returns a short-lived migration link. `/migration` offers a same-site form if an embedded browser cannot open it. The form accepts only this deployment's migration callback URL and validates the same browser session and one-time code.

After connection import, `scripts/migrate-history.py` uses the approved private transfer capability to archive and copy original saved test records and R2 evidence. It verifies stored evidence checksums, preserves run IDs, maps connection IDs, and rejects ownership collisions. Evidence moves in bounded batches through an expiring account capability; each stored file is read back and checked before the batch is acknowledged. Use `--resume --indexed` to reuse an already saved private source snapshot and evidence index. Copied monitors start paused so the original and new schedulers cannot accidentally issue duplicate paid requests. They can be resumed in Availability Monitor after retiring their originals. Source snapshots and completion counts remain private in R2.

Some source hosts reject requests originating directly from Workers. The authenticated administrator relay `scripts/stage-transfer.mjs` exchanges the approved one-time source code locally and encrypts the export with a key derived from the secret PKCE verifier before placing it in private R2. The callback still requires the initiating Google session, decrypts and validates the envelope, and removes the staging object after successful import. It never exposes provider keys to the browser.

## Concurrency measurement

The RPM/RPS test explores concurrency levels 5, 10, 25, 50, 100 and 200 automatically, or uses a custom list such as 60, 61, 70. Custom lists accept 1–12 distinct, increasing whole numbers from 1–200; a single number tests just that level. The selected plan is stored with the run and retained in history and exports. Each level runs for up to 60 seconds with a budget of max(100, concurrency × 5) short requests; the default plan is bounded at 2,075 requests plus preflight. The UI shows the selected plan's total budget. Automatic tests stop increasing load after a request failure. Custom tests continue replacing requests after provider errors (including timeouts and HTTP 429) and finish every selected level within its original window and budget. Cancellation or a tester delivery/evidence failure still stops the run. The selected behavior is stored with the run; older runs retain their original stop behavior.

Independent dispatchers use up to five provider calls in flight and at most 25 calls per invocation. Partial dispatchers preserve exact targets: 61 uses twelve five-slot dispatchers and one single-slot dispatcher, with proportional request budgets. A shared start barrier aligns each level. Evidence is saved between chunks, outside request replacement; continuation gaps are included in the observed rate. Results show successful RPM/RPS, median TTFT of successful in-window streaming responses, actual peak and time-weighted average concurrency, errors, 429s and late responses. TTFT starts at upstream request submission and ends at the first answer text, excluding headers, keepalives, role metadata and reasoning-only deltas. The stream is read through completion before a request counts as successful. Non-streaming responses and legacy runs have no TTFT; completion latency remains in raw evidence. Versions 2–4 use streaming for both preflight and measurement; version 3 stores the custom plan and version 4 also stores the automatic/custom error policy. In-progress older runs retain their original plan, error policy and streaming behavior.

A clean run reports **Limit not reached**, including when the tester reaches its own budget or concurrency ceiling. These are bounded short-request observations, not certified provider limits or sustained production capacity. Legacy fixed-five results remain available with that limitation made explicit. Normal Token Check continues to show TTFT and token/s.

The browser remembers the last selected model and API format separately for each saved connection, shared between All tests and Pelican. Reloading or switching pages restores that choice without changing the connection’s saved defaults. Removed models fall back to an available default; no API keys are stored in these preferences.
