import { env } from 'cloudflare:workers';
import { and, asc, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getDb } from '@/db';
import { rpmRuns, rpmStages } from '@/db/schema';
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

async function readEvidence(keys: string[]) {
  const evidence: RpmRequestEvidence[] = [];
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
        evidence.push(...parsed.requests);
      } catch {
        malformedObjects += 1;
      }
    }
  }
  return { evidence, malformedObjects };
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
    const stageRows = await getDb()
      .select()
      .from(rpmStages)
      .where(eq(rpmStages.runId, id))
      .orderBy(asc(rpmStages.stageIndex));
    const current = stageRows.find((item) => item.stageIndex === stageIndex);
    if (!current)
      return noStore({ error: 'RPM stage not found.' }, { status: 404 });
    if (current.status !== 'running')
      return noStore(
        { error: `This stage is already ${current.status}.` },
        { status: 409 },
      );

    const prefix = `rpm/v1/${id}/results/s${String(stageIndex).padStart(2, '0')}/`;
    const keys = await listR2Keys(env.EVIDENCE, prefix);
    const { evidence, malformedObjects } = await readEvidence(keys);
    const sequences = new Set(
      evidence
        .filter(
          (item) =>
            item.runId === id &&
            item.stageIndex === stageIndex &&
            Number.isInteger(item.sequence) &&
            item.sequence >= 0 &&
            item.sequence < current.scheduledCount,
        )
        .map((item) => item.sequence),
    );
    const validEvidence = evidence.filter(
      (item) =>
        item.runId === id &&
        item.stageIndex === stageIndex &&
        sequences.has(item.sequence),
    );
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
    const missingCount = Math.max(0, current.scheduledCount - sequences.size);
    const missedDispatchCount = explicitMissed + missingCount;
    const attemptedCount = validEvidence.length - explicitMissed;
    const dispatchValid =
      malformedObjects === 0 &&
      evidence.length === current.scheduledCount &&
      sequences.size === current.scheduledCount &&
      explicitMissed === 0;
    const successRateBps = Math.round(
      (successCount * 10_000) / current.scheduledCount,
    );
    const latencies = validEvidence
      .filter((item) => item.outcome !== 'missed_dispatch')
      .map((item) => item.totalTimeMs)
      .filter(Number.isFinite);
    const scheduleLags = validEvidence
      .map((item) => Math.max(0, item.scheduleLagMs))
      .filter(Number.isFinite);
    const stageStatus = !dispatchValid
      ? 'inconclusive'
      : successCount * 10_000 >= run.thresholdBps * current.scheduledCount
        ? 'passed'
        : 'failed';
    const finishedAt = Date.now();
    const stageUpdate = env.DB.prepare(
      "UPDATE rpm_stages SET status = ?, finished_at = ?, attempted_count = ?, success_count = ?, rate_limited_count = ?, client_error_count = ?, server_error_count = ?, timeout_count = ?, transport_error_count = ?, malformed_count = ?, missed_dispatch_count = ?, success_rate_bps = ?, dispatch_valid = ?, median_latency_ms = ?, p95_latency_ms = ?, p95_schedule_lag_ms = ? WHERE run_id = ? AND stage_index = ? AND status = 'running' AND EXISTS (SELECT 1 FROM rpm_runs WHERE id = ? AND user_id = ? AND status = 'running')",
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
    const stopReason =
      stageStatus === 'failed'
        ? `Stage ${stageIndex + 1} achieved ${(successRateBps / 100).toFixed(2)}%, below the ${(run.thresholdBps / 100).toFixed(2)}% requirement.`
        : stageStatus === 'inconclusive'
          ? 'The tester could not dispatch and preserve every scheduled request, so provider reliability was not judged.'
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
        stageStatus === 'passed' ? current.targetRpm : run.highestPassedRpm,
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
