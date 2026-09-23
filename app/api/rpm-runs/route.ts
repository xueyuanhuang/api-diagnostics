import { openRouterRoute } from '@/lib/openrouter';
import { env } from 'cloudflare:workers';
import { validateOutboundUrl } from '@/lib/server/connection';
import { desc, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getDb } from '@/db';
import { rpmActiveLeases, rpmRuns } from '@/db/schema';
import {
  buildRampTargets,
  RPM_MAX_TARGET_RPM,
  rpmShardCount,
  type RpmRampMode,
} from '@/lib/rpm-types';
import { noStore, serverError } from '@/lib/server/http';
import { getOwnedProfileConfig } from '@/lib/server/profile-config';
import { runDetail, runSummary } from '@/lib/server/rpm-store';

const STAGE_DURATION_SECONDS = 60;
const LEASE_MS = 2 * 60 * 60 * 1_000;
const STALE_PREFLIGHT_MS = 90_000;
const DEFAULT_MAX_REQUESTS_PER_RUN = 25_000;

type StartPayload = {
  allowInsecureHttp?: unknown;
  profileId?: unknown;
  apiType?: unknown;
  model?: unknown;
  targetRpm?: unknown;
  thresholdPercent?: unknown;
  rampMode?: unknown;
  runnerVersion?: unknown;
  durationSeconds?: unknown;
  openRouterTier?: unknown;
};

function integer(value: unknown) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(number) ? number : null;
}

export async function GET() {
  const user = await getChatGPTUser();
  if (!user)
    return noStore({ error: 'Sign in to view RPM runs.' }, { status: 401 });
  try {
    const rows = await getDb()
      .select()
      .from(rpmRuns)
      .where(eq(rpmRuns.userId, user.userId))
      .orderBy(desc(rpmRuns.createdAt))
      .limit(500);
    return noStore({ runs: rows.map(runSummary) });
  } catch (error) {
    return serverError(error);
  }
}

export async function POST(request: NextRequest) {
  const user = await getChatGPTUser();
  if (!user)
    return noStore({ error: 'Sign in to run an RPM test.' }, { status: 401 });

  let payload: StartPayload;
  try {
    payload = (await request.json()) as StartPayload;
  } catch {
    return noStore({ error: 'Invalid request body.' }, { status: 400 });
  }

  // Reject stale browser code before credentials are read or any run is created.
  if (payload.rampMode === 'automatic' && payload.runnerVersion !== 2)
    return noStore({ error: 'This test page is out of date. Refresh the page before starting a test. No provider requests were sent.' }, { status: 409 });

  const profileId =
    typeof payload.profileId === 'string' ? payload.profileId : '';
  const model = typeof payload.model === 'string' ? payload.model.trim() : '';
  const apiType = payload.apiType;
  const targetRpm = payload.rampMode === 'automatic' ? 1 : integer(payload.targetRpm);
  const thresholdPercent = integer(payload.thresholdPercent ?? 90);
  const rampMode: RpmRampMode =
    payload.rampMode === 'automatic' ? 'automatic' : payload.rampMode === 'fixed' ? 'fixed' : payload.rampMode === 'detailed' ? 'detailed' : 'balanced';
  if (!profileId)
    return noStore(
      { error: 'Save or select a connection profile before an RPM test.' },
      { status: 400 },
    );
  if (apiType !== 'anthropic' && apiType !== 'openai')
    return noStore({ error: 'Choose a valid API type.' }, { status: 400 });
  if (!model || model.length > 120)
    return noStore({ error: 'Enter a valid model name.' }, { status: 400 });
  if (targetRpm === null || targetRpm < 1)
    return noStore(
      { error: 'Target RPM must be a positive whole number.' },
      { status: 400 },
    );
  if (targetRpm > RPM_MAX_TARGET_RPM)
    return noStore(
      {
        error: `This deployment supports targets up to ${RPM_MAX_TARGET_RPM.toLocaleString()} RPM.`,
      },
      { status: 400 },
    );
  if (
    thresholdPercent === null ||
    thresholdPercent < 1 ||
    thresholdPercent > 100
  ) {
    return noStore(
      { error: 'Minimum success rate must be from 1% to 100%.' },
      { status: 400 },
    );
  }

  let config;
  try {
    config = await getOwnedProfileConfig({
      userId: user.userId,
      profileId,
      apiType,
      requestedModel: model,
    });
  } catch (error) {
    return serverError(error);
  }
  if (!config)
    return noStore(
      { error: 'Saved profile, API type, or model not found.' },
      { status: 404 },
    );

  const duration = rampMode === 'fixed' ? integer(payload.durationSeconds ?? 60) : STAGE_DURATION_SECONDS;
  if (duration === null || duration < 10 || duration > 300) return noStore({error: 'Duration must be 10–300 whole seconds.'}, {status:400});
  try { openRouterRoute(config.baseUrl, apiType, model, payload.openRouterTier); } catch (error) { return noStore({error: (error as Error).message}, {status:400}); }
  const outbound = validateOutboundUrl(
    config.baseUrl,
    payload.allowInsecureHttp,
  );
  if ('error' in outbound)
    return noStore({ error: outbound.error }, { status: 400 });
  const targets = (rampMode === 'automatic' ? [{percentage:100,targetRpm:0}] : buildRampTargets(targetRpm, rampMode)).map((stage) => ({
    ...stage,
    scheduledCount: Math.max(
      1,
      Math.round((stage.targetRpm * duration) / 60),
    ),
  }));
  const totalPlanned = rampMode === 'automatic' ? 300 : targets.reduce(
    (total, stage) => total + stage.scheduledCount,
    0,
  );
  const configuredMax = Number(
    (env as unknown as { RPM_MAX_REQUESTS_PER_RUN?: string })
      .RPM_MAX_REQUESTS_PER_RUN,
  );
  const maxRequests =
    Number.isFinite(configuredMax) && configuredMax > 0
      ? Math.floor(configuredMax)
      : DEFAULT_MAX_REQUESTS_PER_RUN;
  if (totalPlanned > maxRequests) {
    return noStore(
      {
        error: `This plan contains ${totalPlanned.toLocaleString()} requests, above this deployment's ${maxRequests.toLocaleString()}-request safety budget. Lower the target or use the balanced ramp.`,
      },
      { status: 400 },
    );
  }

  const now = Date.now();
  const existing = await getDb()
    .select()
    .from(rpmActiveLeases)
    .where(eq(rpmActiveLeases.userId, user.userId))
    .limit(1);
  const activeRows = existing.length
    ? await getDb()
        .select()
        .from(rpmRuns)
        .where(eq(rpmRuns.id, existing[0].runId))
        .limit(1)
    : [];
  const activeRun = activeRows[0];
  let preflightActivityAt = activeRun?.createdAt ?? now;
  if (activeRun?.status === 'preflight') {
    try {
      const claim = await env.EVIDENCE.get(
        `rpm/v1/${activeRun.id}/preflight-claim`,
      );
      const claimedAt = claim ? Number(await claim.text()) : Number.NaN;
      if (Number.isFinite(claimedAt)) preflightActivityAt = claimedAt;
    } catch {
      // Fall back to creation time; recovery still requires the full grace period.
    }
  }
  const stalePreflight =
    activeRun?.status === 'preflight' &&
    now - preflightActivityAt >= STALE_PREFLIGHT_MS;
  const activeStatus =
    activeRun && ['preflight', 'ready', 'running'].includes(activeRun.status);
  if (
    existing.length &&
    existing[0].expiresAt > now &&
    activeStatus &&
    !stalePreflight
  ) {
    return noStore(
      {
        error:
          'You already have an active RPM run. Open it or cancel it before starting another.',
        activeRunId: existing[0].runId,
        activeRunStatus: activeRun?.status ?? 'unknown',
      },
      { status: 409 },
    );
  }
  if (existing.length) {
    const reason = stalePreflight
      ? 'The preflight did not finish within 90 seconds. It was recovered automatically before this new run.'
      : 'The active-run lease expired before completion.';
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE rpm_runs SET status = 'inconclusive', stop_reason = ?, finished_at = ? WHERE id = ? AND status IN ('preflight', 'ready', 'running')",
      ).bind(reason, now, existing[0].runId),
      env.DB.prepare(
        "UPDATE rpm_stages SET status = 'inconclusive', finished_at = ? WHERE run_id = ? AND status IN ('running', 'finalizing')",
      ).bind(now, existing[0].runId),
      env.DB.prepare(
        "UPDATE rpm_stages SET status = 'skipped' WHERE run_id = ? AND status = 'pending'",
      ).bind(existing[0].runId),
      env.DB.prepare('DELETE FROM rpm_run_secrets WHERE run_id = ?').bind(
        existing[0].runId,
      ),
      env.DB.prepare(
        'DELETE FROM rpm_active_leases WHERE user_id = ? AND run_id = ?',
      ).bind(user.userId, existing[0].runId),
    ]);
  }

  const runId = crypto.randomUUID();
  const thresholdBps = thresholdPercent * 100;
  try {
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO rpm_runs (id, user_id, profile_id, profile_name, api_type, base_url, model_name, openrouter_tier, ramp_mode, target_rpm, stage_duration_seconds, threshold_bps, status, total_planned, total_attempted, total_succeeded, total_rate_limited, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?)',
      ).bind(
        runId,
        user.userId,
        profileId,
        `${config.profileName}${payload.openRouterTier ? ` · ${payload.openRouterTier === 'flex' ? 'Flex' : 'Standard'} requested` : ''}`,
        apiType,
        config.baseUrl,
        model,
        (payload.openRouterTier as string) || null,
        rampMode,
        rampMode === 'automatic' ? 0 : targetRpm,
        duration,
        thresholdBps,
        'preflight',
        totalPlanned,
        now,
      ),
      ...targets.map((stage, stageIndex) =>
        env.DB.prepare(
          'INSERT INTO rpm_stages (id, run_id, stage_index, percentage, target_rpm, scheduled_count, batch_count, status, attempted_count, success_count, rate_limited_count, client_error_count, server_error_count, timeout_count, transport_error_count, malformed_count, missed_dispatch_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0)',
        ).bind(
          crypto.randomUUID(),
          runId,
          stageIndex,
          stage.percentage,
          stage.targetRpm,
          stage.scheduledCount,
          rpmShardCount(stage.scheduledCount),
          'pending',
        ),
      ),
      env.DB.prepare(
        'INSERT INTO rpm_run_secrets (run_id, encrypted_api_key, key_iv) VALUES (?, ?, ?)',
      ).bind(runId, config.encryptedApiKey, config.keyIv),
      env.DB.prepare(
        'INSERT INTO rpm_active_leases (user_id, run_id, expires_at) VALUES (?, ?, ?)',
      ).bind(user.userId, runId, now + LEASE_MS),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.toLowerCase().includes('unique')) {
      const active = await getDb()
        .select()
        .from(rpmActiveLeases)
        .where(eq(rpmActiveLeases.userId, user.userId))
        .limit(1);
      return noStore(
        {
          error: 'You already have an active RPM run.',
          activeRunId: active[0]?.runId ?? null,
        },
        { status: 409 },
      );
    }
    return serverError(error);
  }

  const rows = await getDb()
    .select()
    .from(rpmRuns)
    .where(eq(rpmRuns.id, runId))
    .limit(1);
  return noStore(await runDetail(rows[0]), { status: 201 });
}
