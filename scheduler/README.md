# Availability scheduling

The API Diagnostics Worker owns saved targets, encrypted connection profiles and D1 history. This small ordinary Cloudflare Worker is only a clock: every ten minutes it calls the Site's signed scheduler endpoint. It never receives provider API keys. No second website or public Worker route is created.

`wrangler.jsonc` defines the schedule and Cloudflare app URL. Deploy this Worker in the configured Cloudflare account and set `AVAILABILITY_TRIGGER_SECRET` as a Worker secret. Set the same secret on the api-diagnostics Worker. Keep secret values out of configuration files, source control and logs.

The worker signs the method, path, timestamp and request-body digest with HMAC-SHA256. The Site rejects modified payloads and timestamps outside a two-minute window. The logical interval comes from the scheduled event time. A D1 conditional insert permits one attempt per target and interval, including concurrent/retried deliveries. A claimed but interrupted attempt remains unknown; it is not sent again within the same interval.

Up to 200 active targets are supported across this Site. Six scheduler requests run concurrently, each checking at most ten targets with five concurrent provider requests. Provider responses time out after 30 seconds. The scheduler has an eight-minute delivery budget and retries only transient delivery failures. Targets with the oldest attempts take priority if a previous interval was interrupted. A completed provider failure is an HTTP 200 scheduler result, not a reason to retry a paid probe.

The first probe runs when a signed-in user adds a target. Removing a target stops future claims; an already-sent request may finish. Re-adding creates a new monitoring identity so its first check is not suppressed by old evidence. A changed saved base URL requires removing and re-adding the target. Every read and mutation is scoped to the signed-in owner. Recent history shows 24 actual ten-minute intervals; missing, interrupted and stale checks remain unknown. Samples for active targets are retained for seven days.

Tests in `tests/availability.test.mjs` cover the generated migrations, ownership, duplicate claims, deletion/re-add races, target capacity, response validation, redaction, stale history, signed payloads, batching and retries. Validate with the existing project test/build scripts and a Wrangler dry run of this scheduler before publication.
