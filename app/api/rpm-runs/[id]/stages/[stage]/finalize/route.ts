import { env } from 'cloudflare:workers';
import { and, asc, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getDb } from '@/db';
import { rpmRuns, rpmStages } from '@/db/schema';
import {
  rpmMeasurementStatus,
  RPM_FINALIZE_GRACE_MS,
  RPM_FINALIZE_SETTLE_MS,
  RPM_MAX_DISPATCH_SHARDS,
  RPM_REQUEST_TIMEOUT_MS,
} from '@/lib/rpm-types';
import { noStore, serverError } from '@/lib/server/http';
import type { RpmRequestEvidence } from '@/lib/server/rpm-provider';
import {
  listR2Keys,
  median,
  percentile,
  runDetail,
} from '@/lib/server/rpm-store';

type Context = { params: Promise<{ id: string; stage: string }> };
type BatchEvidence = { requests?: RpmRequestEvidence[] };
type AggregateEvidence = Pick<
  RpmRequestEvidence,
  | 'runId'
  | 'stageIndex'
  | 'sequence'
  | 'outcome'
  | 'totalTimeMs'
  | 'scheduleLagMs'
> & { verdictEligible: boolean };
type DispatcherManifest = {
  runId?: unknown;
  stageIndex?: unknown;
  shardIndex?: unknown;
  shardCount?: unknown;
  complete?: unknown;
  failed?: unknown;
  error?: unknown;
  requests?: unknown;
};

async function readEvidence(keys: string[]) {
  const evidence: AggregateEvidence[] = [];
  let malformedObjects = 0;
  for (let index = 0; index < keys.length; index += 5) {
    const objects = await Promise.all(
      keys.slice(index, index + 5).map((key) => env.EVIDENCE.get(key)),
    );
    const texts = await Promise.all(
      objects.map((object) => (object ? object.text() : Promise.resolve(''))),
    );
    for (const text of texts) {
      try {
        const parsed = JSON.parse(text) as BatchEvidence;
        if (!Array.isArray(parsed.requests)) {
          malformedObjects += 1;
          continue;
        }
        const verdictEligible =
          typeof (parsed as { verdictEligible?: unknown }).verdictEligible ===
          'boolean'
            ? (parsed as { verdictEligible: boolean }).verdictEligible
            : true;
        evidence.push(
          ...parsed.requests.map((item) => ({ ...item, verdictEligible })),
        );
      } catch {
        malformedObjects += 1;
      }
    }
  }
  return { evidence, malformedObjects };
}

async function readDispatcherManifests(keys: string[]) {
  const manifests = new Map<number, DispatcherManifest>();
  let malformedObjects = 0;
  for (let index = 0; index < keys.length; index += 5) {
    const objects = await Promise.all(
      keys.slice(index, index + 5).map((key) => env.EVIDENCE.get(key)),
    );
    const texts = await Promise.all(
      objects.map((object) => (object ? object.text() : Promise.resolve(''))),
    );
    for (const text of texts) {
      try {
        const parsed = JSON.parse(text) as DispatcherManifest;
        if (!Number.isInteger(parsed.shardIndex)) {
          malformedObjects += 1;
          continue;
        }
        const shardIndex = parsed.shardIndex as number;
        if (manifests.has(shardIndex)) malformedObjects += 1;
        else manifests.set(shardIndex, parsed);
      } catch {
        malformedObjects += 1;
      }
    }
  }
  return { manifests, malformedObjects };
}

function aggregateRequests(
  manifest: DispatcherManifest,
  runId: string,
  stageIndex: number,
) {
  const outcomes = new Set<RpmRequestEvidence['outcome']>([
    'success',
    'rate_limited',
    'client_error',
    'server_error',
    'timeout',
    'transport_error',
    'malformed',
    'missed_dispatch',
  ]);
  if (!Array.isArray(manifest.requests)) return null;
  const requests: AggregateEvidence[] = [];
  for (const value of manifest.requests) {
    if (!value || typeof value !== 'object') return null;
    const item = value as Partial<AggregateEvidence>;
    if (
      item.runId !== runId ||
      item.stageIndex !== stageIndex ||
      !Number.isInteger(item.sequence) ||
      typeof item.verdictEligible !== 'boolean' ||
      typeof item.outcome !== 'string' ||
      !outcomes.has(item.outcome as RpmRequestEvidence['outcome']) ||
      typeof item.totalTimeMs !== 'number' ||
      !Number.isFinite(item.totalTimeMs) ||
      item.totalTimeMs < 0 ||
      typeof item.scheduleLagMs !== 'number' ||
      !Number.isFinite(item.scheduleLagMs) ||
      item.scheduleLagMs < 0
    ) {
      return null;
    }
    requests.push(item as AggregateEvidence);
  }
  return requests;
}

export async function POST(_request: NextRequest, context: Context) {
  const user = await getChatGPTUser();
  if (!user)
    return noStore({ error: 'Sign in to finish this run.' }, { status: 401 });
  const { id, stage } = await context.params;
  const stageIndex = Number(stage);
  if (!Number.isInteger(stageIndex) || stageIndex < 0)
    return noStore({ error: 'Invalid RPM stage.' }, { status: 400 });

  try {
    const runs = await getDb()
      .select()
      .from(rpmRuns)
      .where(and(eq(rpmRuns.id, id), eq(rpmRuns.userId, user.userId)))
      .limit(1);
    if (!runs.length)
      return noStore({ error: 'RPM run not found.' }, { status: 404 });
    const run = runs[0];
    if (run.rampMode === 'concurrency') return noStore({error:'Use concurrency finalization for this run.'}, {status:409});
    const stageRows = await getDb()
      .select()
      .from(rpmStages)
      .where(eq(rpmStages.runId, id))
      .orderBy(asc(rpmStages.stageIndex));
    const current = stageRows.find((item) => item.stageIndex === stageIndex);
    if (!current)
      return noStore({ error: 'RPM stage not found.' }, { status: 404 });
    if (!['running', 'finalizing'].includes(current.status)) {
      if (
        ['passed', 'failed', 'inconclusive', 'cancelled'].includes(
          current.status,
        )
      ) {
        return noStore(await runDetail(run));
      }
      return noStore(
        { error: `This stage is already ${current.status}.` },
        { status: 409 },
      );
    }
    if (run.status !== 'running') return noStore(await runDetail(run));

    if (current.status === 'finalizing') {
      if (current.finishedAt === null) {
        const freezeStartedAt = Date.now();
        await env.DB.prepare(
          "UPDATE rpm_stages SET finished_at = ? WHERE run_id = ? AND stage_index = ? AND status = 'finalizing' AND finished_at IS NULL AND EXISTS (SELECT 1 FROM rpm_runs WHERE id = ? AND user_id = ? AND status = 'running')",
        )
          .bind(freezeStartedAt, id, stageIndex, id, user.userId)
          .run();
        return noStore(
          {
            error:
              'The stage evidence is frozen while in-flight persistence settles.',
            finalizationPending: true,
            retryAfterMs: RPM_FINALIZE_SETTLE_MS,
          },
          { status: 409 },
        );
      }
      const settleRemainingMs =
        current.finishedAt + RPM_FINALIZE_SETTLE_MS - Date.now();
      if (settleRemainingMs > 0) {
        return noStore(
          {
            error:
              'The stage evidence is frozen while in-flight persistence settles.',
            finalizationPending: true,
            retryAfterMs: Math.min(RPM_FINALIZE_SETTLE_MS, settleRemainingMs),
          },
          { status: 409 },
        );
      }
    }

    const stagePart = String(stageIndex).padStart(2, '0');
    const dispatchStartPrefix = `rpm/v1/${id}/dispatch-starts/s${stagePart}/`;
    const dispatcherPrefix = `rpm/v1/${id}/dispatchers/s${stagePart}/`;
    const dispatcherKeys = await listR2Keys(env.EVIDENCE, dispatcherPrefix);
    let evidence: AggregateEvidence[];
    let malformedObjects = 0;
    let manifestIntegrityValid = true;
    let readyDispatcherCount = 0;
    let completedDispatcherCount = 0;
    let failedDispatcherCount = 0;
    let missingDispatcherCount = 0;
    const dispatcherErrorMessages: string[] = [];

    if (dispatcherKeys.length) {
      const shardCount = current.batchCount;
      if (
        !Number.isInteger(shardCount) ||
        shardCount < 1 ||
        shardCount > RPM_MAX_DISPATCH_SHARDS
      ) {
        return noStore(
          { error: 'This stage has an unsupported dispatcher layout.' },
          { status: 409 },
        );
      }
      const read = await readDispatcherManifests(dispatcherKeys);
      readyDispatcherCount = read.manifests.size;
      malformedObjects += read.malformedObjects;
      evidence = [];
      let everyExpectedManifestComplete = true;
      let dispatcherFailed = false;
      for (let shardIndex = 0; shardIndex < shardCount; shardIndex += 1) {
        const manifest = read.manifests.get(shardIndex);
        if (!manifest) {
          everyExpectedManifestComplete = false;
          continue;
        }
        if (
          typeof manifest.complete !== 'boolean' ||
          typeof manifest.failed !== 'boolean'
        ) {
          malformedObjects += 1;
        }
        if (manifest.complete !== true) everyExpectedManifestComplete = false;
        else completedDispatcherCount += 1;
        if (manifest.failed === true) {
          dispatcherFailed = true;
          failedDispatcherCount += 1;
        }
        if (
          typeof manifest.error === 'string' &&
          manifest.error.trim() &&
          !dispatcherErrorMessages.includes(manifest.error.trim())
        ) {
          dispatcherErrorMessages.push(manifest.error.trim());
        }
        if (
          manifest.runId !== id ||
          manifest.stageIndex !== stageIndex ||
          manifest.shardIndex !== shardIndex ||
          manifest.shardCount !== shardCount
        ) {
          malformedObjects += 1;
          continue;
        }
        const requests = aggregateRequests(manifest, id, stageIndex);
        if (!requests) malformedObjects += 1;
        else evidence.push(...requests);
      }
      missingDispatcherCount = Math.max(0, shardCount - read.manifests.size);
      if (read.manifests.size !== shardCount) malformedObjects += 1;

      if (current.scheduledStartAt !== null && !everyExpectedManifestComplete) {
        const deadline =
          current.scheduledStartAt +
          run.stageDurationSeconds * 1_000 +
          RPM_REQUEST_TIMEOUT_MS +
          RPM_FINALIZE_GRACE_MS;
        const retryAfterMs = Math.max(0, deadline - Date.now());
        if (retryAfterMs > 0) {
          return noStore(
            {
              error:
                'Server dispatchers are still finishing and preserving evidence.',
              finalizationPending: true,
              retryAfterMs: Math.min(1_000, retryAfterMs),
            },
            { status: 409 },
          );
        }
        if (current.status === 'running') {
          const freezeStartedAt = Date.now();
          await env.DB.prepare(
            "UPDATE rpm_stages SET status = 'finalizing', finished_at = ? WHERE run_id = ? AND stage_index = ? AND status = 'running' AND EXISTS (SELECT 1 FROM rpm_runs WHERE id = ? AND user_id = ? AND status = 'running')",
          )
            .bind(freezeStartedAt, id, stageIndex, id, user.userId)
            .run();
          return noStore(
            {
              error:
                'The stage window ended. Freezing late writes before the final evidence count.',
              finalizationPending: true,
              retryAfterMs: RPM_FINALIZE_SETTLE_MS,
            },
            { status: 409 },
          );
        }
      }
      if (current.status === 'finalizing' && !everyExpectedManifestComplete) {
        const resultPrefix = `rpm/v1/${id}/results/s${stagePart}/`;
        const resultKeys = await listR2Keys(env.EVIDENCE, resultPrefix);
        const detailed = await readEvidence(resultKeys);
        evidence = detailed.evidence;
        malformedObjects += detailed.malformedObjects;
      }
      manifestIntegrityValid =
        everyExpectedManifestComplete && !dispatcherFailed;
    } else {
      const prefix = `rpm/v1/${id}/results/s${stagePart}/`;
      const keys = await listR2Keys(env.EVIDENCE, prefix);
      const legacy = await readEvidence(keys);
      evidence = legacy.evidence;
      malformedObjects = legacy.malformedObjects;
    }

    const evidenceBySequence = new Map<number, AggregateEvidence>();
    for (const item of evidence) {
      if (
        item.runId !== id ||
        item.stageIndex !== stageIndex ||
        !Number.isInteger(item.sequence) ||
        item.sequence < 0 ||
        item.sequence >= current.scheduledCount
      ) {
        malformedObjects += 1;
      } else if (evidenceBySequence.has(item.sequence)) {
        malformedObjects += 1;
      } else {
        evidenceBySequence.set(item.sequence, item);
      }
    }
    const validEvidence = [...evidenceBySequence.values()];
    const verdictEvidence = validEvidence.filter(
      (item) => item.verdictEligible,
    );
    const dispatchStartKeys = await listR2Keys(
      env.EVIDENCE,
      dispatchStartPrefix,
    );
    const sentSequences = new Set(
      validEvidence
        .filter((item) => item.outcome !== 'missed_dispatch')
        .map((item) => item.sequence),
    );
    for (const key of dispatchStartKeys) {
      const relativeKey = key.slice(dispatchStartPrefix.length);
      const match = /^request-(\d{6})\.json$/.exec(relativeKey);
      const sequence = match ? Number(match[1]) : Number.NaN;
      if (
        !Number.isInteger(sequence) ||
        sequence < 0 ||
        sequence >= current.scheduledCount ||
        sentSequences.has(sequence)
      ) {
        if (!sentSequences.has(sequence)) malformedObjects += 1;
        continue;
      }
      sentSequences.add(sequence);
    }
    const count = (outcome: RpmRequestEvidence['outcome']) =>
      validEvidence.filter((item) => item.outcome === outcome).length;
    const successCount = count('success');
    const rateLimitedCount = count('rate_limited');
    const clientErrorCount = count('client_error');
    const serverErrorCount = count('server_error');
    const timeoutCount = count('timeout');
    const transportErrorCount = count('transport_error');
    const malformedCount = count('malformed');
    const explicitMissed = count('missed_dispatch');
    const excludedFromVerdictCount =
      validEvidence.length - verdictEvidence.length;
    const responseCount = validEvidence.length - explicitMissed;
    const attemptedCount = sentSequences.size;
    const missedDispatchCount = Math.max(
      0,
      current.scheduledCount - attemptedCount,
    );
    const missingResponseCount = Math.max(0, attemptedCount - responseCount);
    const dispatchValid =
      manifestIntegrityValid &&
      malformedObjects === 0 &&
      responseCount === current.scheduledCount &&
      attemptedCount === current.scheduledCount &&
      evidenceBySequence.size === current.scheduledCount &&
      excludedFromVerdictCount === 0 &&
      explicitMissed === 0;
    const successRateBps = responseCount
      ? Math.round((successCount * 10_000) / responseCount)
      : 0;
    const latencies = validEvidence
      .filter((item) => item.outcome !== 'missed_dispatch')
      .map((item) => item.totalTimeMs)
      .filter(Number.isFinite);
    const scheduleLags = validEvidence
      .map((item) => Math.max(0, item.scheduleLagMs))
      .filter(Number.isFinite);
    const stageStatus = rpmMeasurementStatus(run.rampMode, dispatchValid, successCount, responseCount, run.thresholdBps);
    const finishedAt = Date.now();
    const stageUpdate = env.DB.prepare(
      "UPDATE rpm_stages SET status = ?, finished_at = ?, attempted_count = ?, success_count = ?, rate_limited_count = ?, client_error_count = ?, server_error_count = ?, timeout_count = ?, transport_error_count = ?, malformed_count = ?, missed_dispatch_count = ?, success_rate_bps = ?, dispatch_valid = ?, median_latency_ms = ?, p95_latency_ms = ?, p95_schedule_lag_ms = ? WHERE run_id = ? AND stage_index = ? AND status IN ('running', 'finalizing') AND EXISTS (SELECT 1 FROM rpm_runs WHERE id = ? AND user_id = ? AND status = 'running')",
    ).bind(
      stageStatus,
      finishedAt,
      attemptedCount,
      successCount,
      rateLimitedCount,
      clientErrorCount,
      serverErrorCount,
      timeoutCount,
      transportErrorCount,
      malformedCount,
      missedDispatchCount,
      successRateBps,
      dispatchValid ? 1 : 0,
      median(latencies),
      percentile(latencies, 0.95),
      percentile(scheduleLags, 0.95),
      id,
      stageIndex,
      id,
      user.userId,
    );

    const isLast = stageIndex === stageRows.length - 1;
    const terminal = stageStatus !== 'passed' || isLast;
    const finalStatus =
      stageStatus === 'passed' ? (isLast ? 'passed' : 'running') : stageStatus;
    const stageWasNeverArmed = current.scheduledStartAt === null;
    const dispatcherLifecycleDetails = stageWasNeverArmed
      ? `The stage was never armed: ${readyDispatcherCount.toLocaleString()}/${current.batchCount.toLocaleString()} dispatcher streams reached the evidence store, ${completedDispatcherCount.toLocaleString()} completed, ${failedDispatcherCount.toLocaleString()} reported an error, and ${missingDispatcherCount.toLocaleString()} never produced a readiness manifest.`
      : null;
    const dispatcherErrors = dispatcherErrorMessages.length
      ? `Dispatcher error: ${dispatcherErrorMessages.join(' | ')}`
      : null;
    const inconclusiveEvidenceDetails = [
      dispatcherLifecycleDetails,
      dispatcherErrors,
      missedDispatchCount
        ? `${missedDispatchCount.toLocaleString()} schedule slots have no verified upstream dispatch start.`
        : null,
      missingResponseCount
        ? `${missingResponseCount.toLocaleString()} verified upstream attempts have no preserved response outcome.`
        : null,
      excludedFromVerdictCount
        ? `${excludedFromVerdictCount.toLocaleString()} preserved responses were excluded because they completed after the verdict freeze or their cutoff state could not be verified.`
        : null,
      !missedDispatchCount &&
      !excludedFromVerdictCount &&
      (!manifestIntegrityValid || malformedObjects)
        ? 'The stored dispatcher evidence set was incomplete, duplicated, failed, or malformed.'
        : null,
    ].filter(Boolean);
    const stopReason =
      stageStatus === 'failed'
        ? `Provider threshold not met at ${current.targetRpm.toLocaleString()} RPM — ${successCount.toLocaleString()}/${attemptedCount.toLocaleString()} sent requests succeeded (${(successRateBps / 100).toFixed(2)}%), below the ${(run.thresholdBps / 100).toFixed(2)}% requirement. The tester delivered the full scheduled load.`
        : stageStatus === 'inconclusive'
          ? `Tester delivery failed at ${current.targetRpm.toLocaleString()} RPM — the tester recorded ${attemptedCount.toLocaleString()} verified upstream dispatch starts from ${current.scheduledCount.toLocaleString()} scheduled requests and preserved ${responseCount.toLocaleString()} response outcomes. ${inconclusiveEvidenceDetails.join(' ')} The provider was not judged at ${current.targetRpm.toLocaleString()} RPM.`
          : null;
    const statements = [stageUpdate];
    if (stageStatus !== 'passed') {
      statements.push(
        env.DB.prepare(
          "UPDATE rpm_stages SET status = 'skipped' WHERE run_id = ? AND stage_index > ? AND status = 'pending' AND EXISTS (SELECT 1 FROM rpm_runs WHERE id = ? AND user_id = ? AND status = 'running') AND EXISTS (SELECT 1 FROM rpm_stages WHERE run_id = ? AND stage_index = ? AND status = ? AND finished_at = ?)",
        ).bind(
          id,
          stageIndex,
          id,
          user.userId,
          id,
          stageIndex,
          stageStatus,
          finishedAt,
        ),
      );
    }
    statements.push(
      env.DB.prepare(
        "UPDATE rpm_runs SET status = ?, highest_passed_rpm = ?, stopped_at_rpm = ?, stop_reason = ?, total_attempted = (SELECT COALESCE(SUM(attempted_count), 0) FROM rpm_stages WHERE run_id = ?), total_succeeded = (SELECT COALESCE(SUM(success_count), 0) FROM rpm_stages WHERE run_id = ?), total_rate_limited = (SELECT COALESCE(SUM(rate_limited_count), 0) FROM rpm_stages WHERE run_id = ?), median_latency_ms = ?, p95_latency_ms = ?, finished_at = ? WHERE id = ? AND user_id = ? AND status = 'running' AND EXISTS (SELECT 1 FROM rpm_stages WHERE run_id = ? AND stage_index = ? AND status = ? AND finished_at = ?)",
      ).bind(
        finalStatus,
        run.rampMode === 'fixed' ? null : stageStatus === 'passed' ? current.targetRpm : run.highestPassedRpm,
        stageStatus === 'passed' ? null : current.targetRpm,
        stopReason,
        id,
        id,
        id,
        median([
          ...stageRows
            .filter((item) => item.stageIndex < stageIndex)
            .map((item) => item.medianLatencyMs)
            .filter((value): value is number => value !== null),
          ...(latencies.length ? [median(latencies)!] : []),
        ]),
        Math.max(
          0,
          ...stageRows
            .filter((item) => item.stageIndex < stageIndex)
            .map((item) => item.p95LatencyMs ?? 0),
          percentile(latencies, 0.95) ?? 0,
        ) || null,
        terminal ? finishedAt : null,
        id,
        user.userId,
        id,
        stageIndex,
        stageStatus,
        finishedAt,
      ),
    );
    if (terminal) {
      statements.push(
        env.DB.prepare(
          'DELETE FROM rpm_run_secrets WHERE run_id = ? AND EXISTS (SELECT 1 FROM rpm_runs WHERE id = ? AND user_id = ? AND status = ? AND finished_at = ?)',
        ).bind(id, id, user.userId, finalStatus, finishedAt),
        env.DB.prepare(
          'DELETE FROM rpm_active_leases WHERE user_id = ? AND run_id = ? AND EXISTS (SELECT 1 FROM rpm_runs WHERE id = ? AND user_id = ? AND status = ? AND finished_at = ?)',
        ).bind(user.userId, id, id, user.userId, finalStatus, finishedAt),
      );
    }
    await env.DB.batch(statements);
    const updated = await getDb()
      .select()
      .from(rpmRuns)
      .where(eq(rpmRuns.id, id))
      .limit(1);
    return noStore(await runDetail(updated[0]));
  } catch (error) {
    return serverError(error);
  }
}
