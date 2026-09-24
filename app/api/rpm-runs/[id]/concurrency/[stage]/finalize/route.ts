import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getDb } from '@/db';
import { rpmRuns, rpmStages } from '@/db/schema';
import {
  concurrencyPlan,
  summarizeConcurrencyStage,
  concurrencyConclusion,
  CONCURRENCY_LEVELS,
  type ConcurrencyManifest,
  type ConcurrencyMetrics,
} from '@/lib/concurrency-test';
import { noStore, serverError } from '@/lib/server/http';
import { runDetail } from '@/lib/server/rpm-store';

type Context = { params: Promise<{ id: string; stage: string }> };
export async function POST(request: NextRequest, context: Context) {
  const user = await getChatGPTUser();
  if (!user)
    return noStore({ error: 'Sign in to finish this test.' }, { status: 401 });
  if (
    request.headers.get('origin') &&
    request.headers.get('origin') !== new URL(request.url).origin
  )
    return noStore({ error: 'Invalid origin.' }, { status: 403 });
  const { id, stage } = await context.params;
  const index = Number(stage);
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index >= CONCURRENCY_LEVELS.length
  )
    return noStore({ error: 'Invalid level.' }, { status: 400 });
  try {
    const rows = await getDb()
      .select({ run: rpmRuns, stage: rpmStages })
      .from(rpmRuns)
      .innerJoin(rpmStages, eq(rpmStages.runId, rpmRuns.id))
      .where(
        and(
          eq(rpmRuns.id, id),
          eq(rpmRuns.userId, user.userId),
          eq(rpmStages.stageIndex, index),
        ),
      )
      .limit(1);
    if (!rows.length)
      return noStore({ error: 'Test not found.' }, { status: 404 });
    const { run, stage: row } = rows[0];
    if (run.rampMode !== 'concurrency')
      return noStore({ error: 'Not a concurrency test.' }, { status: 409 });
    if (
      !['running', 'finalizing'].includes(row.status) ||
      run.status !== 'running' ||
      run.currentStage !== index
    )
      return noStore(await runDetail(run));
    const plan = concurrencyPlan(index);
    const manifests: ConcurrencyManifest[] = [];
    // At most 40 small manifests; sequential reads avoid exhausting connection slots.
    for (let shard = 0; shard < plan.shards; shard++) {
      const object = await env.EVIDENCE.get(
        `rpm/v1/${id}/dispatchers/s${String(index).padStart(2, '0')}/shard-${String(shard).padStart(3, '0')}.ready`,
      );
      if (object) {
        const value = await object.json<ConcurrencyManifest>();
        if (Array.isArray(value.samples)) manifests.push(value);
      }
    }
    const current = summarizeConcurrencyStage(
      index,
      row.scheduledStartAt ?? Date.now(),
      manifests,
    );
    if (row.scheduledStartAt === null) {
      current.complete = false;
      current.outcome = 'tester_incomplete';
    }
    const prior: ConcurrencyMetrics = run.automaticMetricsJson
      ? JSON.parse(run.automaticMetricsJson)
      : { version: 1, stages: [], conclusion: '' };
    const stages = [
      ...prior.stages.filter((s) => s.stageIndex < index),
      current,
    ];
    const metrics: ConcurrencyMetrics = {
      version: prior.version,
      stages,
      conclusion: concurrencyConclusion(stages),
    };
    const continueTest =
      current.outcome === 'no_limit_observed' &&
      index < CONCURRENCY_LEVELS.length - 1;
    const status =
      current.outcome === 'tester_incomplete' ? 'inconclusive' : 'passed';
    const samples = manifests.flatMap((m) => m.samples);
    const count = (outcome: string) =>
      samples.filter((s) => s.outcome === outcome).length;
    const claimed = await env.DB.prepare(
      "UPDATE rpm_stages SET status='finalizing' WHERE run_id=? AND stage_index=? AND status IN ('running','finalizing') AND EXISTS (SELECT 1 FROM rpm_runs WHERE id=? AND status='running' AND current_stage=?)",
    )
      .bind(id, index, id, index)
      .run();
    if (!claimed.meta.changes)
      return noStore(
        { error: 'This level is already being finalized.' },
        { status: 409 },
      );
    const operations = [
      env.DB.prepare(
        "UPDATE rpm_stages SET status=?,finished_at=?,attempted_count=?,success_count=?,rate_limited_count=?,client_error_count=?,server_error_count=?,timeout_count=?,transport_error_count=?,malformed_count=?,dispatch_valid=?,median_latency_ms=?,p95_latency_ms=? WHERE run_id=? AND stage_index=? AND status='finalizing'",
      ).bind(
        status,
        Date.now(),
        current.attempts,
        count('success'),
        count('rate_limited'),
        count('client_error'),
        count('server_error'),
        count('timeout'),
        count('transport_error'),
        count('malformed'),
        current.complete ? 1 : 0,
        current.medianLatencyMs,
        current.p95LatencyMs,
        id,
        index,
      ),
      env.DB.prepare(
        "UPDATE rpm_runs SET automatic_metrics_json=?,status=?,stop_reason=?,finished_at=?,total_attempted=?,total_succeeded=?,total_rate_limited=?,median_latency_ms=?,p95_latency_ms=? WHERE id=? AND status='running' AND current_stage=?",
      ).bind(
        JSON.stringify(metrics),
        continueTest ? 'running' : status,
        continueTest ? null : metrics.conclusion,
        continueTest ? null : Date.now(),
        stages.reduce((n, s) => n + s.attempts, 0),
        stages.reduce((n, s) => n + s.succeeded, 0),
        stages.reduce((n, s) => n + s.rateLimited, 0),
        current.medianLatencyMs,
        current.p95LatencyMs,
        id,
        index,
      ),
    ];
    if (!continueTest)
      operations.push(
        env.DB.prepare(
          "UPDATE rpm_stages SET status='skipped' WHERE run_id=? AND status='pending'",
        ).bind(id),
        env.DB.prepare('DELETE FROM rpm_run_secrets WHERE run_id=?').bind(id),
        env.DB.prepare('DELETE FROM rpm_active_leases WHERE run_id=?').bind(id),
      );
    await env.DB.batch(operations);
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
