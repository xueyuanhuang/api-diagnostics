import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getDb } from '@/db';
import { rpmRuns, rpmRunSecrets } from '@/db/schema';
import { noStore, serverError } from '@/lib/server/http';
import { decryptApiKey } from '@/lib/server/encryption';
import { prepareRpmConnection } from '@/lib/server/hosted-ip-mapping';
import {
  runProviderRequest,
  type RpmRequestEvidence,
} from '@/lib/server/rpm-provider';
import {
  measureAutomaticThroughput,
  type AutomaticMetrics,
} from '@/lib/automatic-throughput';
import { countRpmOutcomes } from '@/lib/server/rpm-evidence';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const user = await getChatGPTUser();
  if (!user)
    return noStore(
      { error: 'Sign in to measure throughput.' },
      { status: 401 },
    );
  if (
    request.headers.get('origin') &&
    request.headers.get('origin') !== new URL(request.url).origin
  )
    return noStore(
      { error: 'Cross-origin request rejected.' },
      { status: 403 },
    );
  const { id } = await context.params;
  try {
    const [run] = await getDb()
      .select()
      .from(rpmRuns)
      .where(and(eq(rpmRuns.id, id), eq(rpmRuns.userId, user.userId)))
      .limit(1);
    if (!run) return noStore({ error: 'Run not found.' }, { status: 404 });
    const payload = (await request.json().catch(() => ({}))) as {
      chunk?: number;
    };
    const chunk = payload.chunk ?? 0;
    if (!Number.isInteger(chunk) || chunk < 0 || chunk >= 12)
      return noStore(
        { error: 'Invalid measurement continuation.' },
        { status: 400 },
      );
    let checkpoint: {
      startedAt: number;
      samples: RpmRequestEvidence[];
    } | null = null;
    if (chunk > 0) {
      const object = await env.EVIDENCE.get(
        `rpm/v1/${id}/checkpoints/${chunk - 1}.json`,
      );
      if (!object)
        return noStore(
          { error: 'Previous measurement segment is not complete.' },
          { status: 409 },
        );
      checkpoint = await object.json();
    }
    if (
      run.rampMode !== 'automatic' ||
      run.status !== (chunk === 0 ? 'ready' : 'running')
    )
      return noStore(
        { error: 'This measurement is not ready, or has already started.' },
        { status: 409 },
      );
    const [secret] = await getDb()
      .select()
      .from(rpmRunSecrets)
      .where(eq(rpmRunSecrets.runId, id))
      .limit(1);
    if (!secret)
      return noStore(
        { error: 'Run credentials unavailable.' },
        { status: 409 },
      );
    const apiKey = await decryptApiKey(secret.encryptedApiKey, secret.keyIv);
    const connection = await prepareRpmConnection(id, run.baseUrl);
    request.signal.throwIfAborted();
    const claim =
      chunk === 0
        ? await env.DB.prepare(
            "UPDATE rpm_runs SET status='running', current_stage=0 WHERE id=? AND user_id=? AND status='ready'",
          )
            .bind(id, user.userId)
            .run()
        : await env.DB.prepare(
            "INSERT OR IGNORE INTO rpm_automatic_chunks(run_id,chunk_index) SELECT id,? FROM rpm_runs WHERE id=? AND user_id=? AND status='running'",
          )
            .bind(chunk, id, user.userId)
            .run();
    if (!claim.meta.changes)
      return noStore(
        { error: 'This segment has already started or the run stopped.' },
        { status: 409 },
      );
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    if (request.signal.aborted) abort.abort();
    request.signal.addEventListener('abort', onAbort, { once: true });
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let closed = false;
        const send = (data: unknown) => {
          if (!closed)
            try {
              controller.enqueue(encoder.encode(JSON.stringify(data) + '\n'));
            } catch {
              closed = true;
              abort.abort();
            }
        };
        let timer: ReturnType<typeof setInterval> | undefined;
        let latest: AutomaticMetrics | null = null;
        let persistence = Promise.resolve();
        try {
          const startedAt = checkpoint?.startedAt ?? Date.now();
          await env.DB.prepare(
            "UPDATE rpm_stages SET status='running',started_at=?,scheduled_start_at=? WHERE run_id=? AND stage_index=0 AND status='pending'",
          )
            .bind(startedAt, startedAt, id)
            .run();
          send({ type: 'started', startedAt });
          timer = setInterval(() => {
            send({ type: 'heartbeat' });
            persistence = persistence
              .then(async () => {
                const state = await env.DB.prepare(
                  'SELECT status FROM rpm_runs WHERE id=?',
                )
                  .bind(id)
                  .first<{ status: string }>();
                if (state?.status !== 'running') abort.abort();
                if (latest)
                  await env.DB.prepare(
                    "UPDATE rpm_runs SET automatic_metrics_json=? WHERE id=? AND status='running'",
                  )
                    .bind(JSON.stringify(latest), id)
                    .run();
              })
              .catch(() => abort.abort());
          }, 1000);
          const measured = await measureAutomaticThroughput({
            signal: abort.signal,
            startedAt,
            initialSamples: checkpoint?.samples,
            chunkSize: 25,
            request: (sequence) =>
              runProviderRequest({
                apiType: run.apiType,
                baseUrl: connection.actualBaseUrl,
                originalBaseUrl: run.baseUrl,
                apiKey,
                model: run.modelName,
                openRouterTier: run.openRouterTier,
                runId: id,
                stageIndex: 0,
                sequence,
                plannedAt: Date.now(),
                timeoutMs: 20_000,
                signal: abort.signal,
              }),
            save: async (sample, sequence) => {
              await env.EVIDENCE.put(
                `rpm/v1/${id}/results/s00/request-${String(sequence).padStart(6, '0')}.json`,
                JSON.stringify({ requests: [sample], verdictEligible: true }),
                { httpMetadata: { contentType: 'application/json' } },
              );
            },
            progress: (metrics) => {
              latest = metrics;
              send({ type: 'progress', metrics });
            },
          });
          clearInterval(timer);
          await persistence;
          if (measured.continuation) {
            await env.EVIDENCE.put(
              `rpm/v1/${id}/checkpoints/${chunk}.json`,
              JSON.stringify({ startedAt, samples: measured.samples }),
            );
            await env.DB.prepare(
              "UPDATE rpm_runs SET automatic_metrics_json=? WHERE id=? AND status='running'",
            )
              .bind(JSON.stringify(measured.metrics), id)
              .run();
            send({
              type: 'continue',
              chunk: chunk + 1,
              metrics: measured.metrics,
            });
            return;
          }
          const metrics = measured.metrics;
          const counts = countRpmOutcomes(measured.samples);
          const status = measured.failed
            ? 'inconclusive'
            : abort.signal.aborted
              ? 'cancelled'
              : 'passed';
          const reason = measured.failed
            ? (measured.failureReason ??
              'Evidence could not be fully saved. Measurement is incomplete.')
            : status === 'cancelled'
              ? 'Stopped early; partial results only.'
              : metrics.stopReason === 'request_cap'
                ? 'Stopped at the built-in 300-request budget. This is a shortened measurement.'
                : 'Completed the 60-second observation window.';
          await env.DB.batch([
            env.DB.prepare(
              "UPDATE rpm_runs SET status=?,automatic_metrics_json=?,total_attempted=?,total_succeeded=?,total_rate_limited=?,median_latency_ms=?,p95_latency_ms=?,finished_at=?,stop_reason=? WHERE id=? AND status IN ('running','cancelled')",
            ).bind(
              status,
              JSON.stringify(metrics),
              metrics.sent,
              counts.succeeded,
              counts.rateLimited,
              metrics.medianLatencyMs,
              metrics.p95LatencyMs,
              Date.now(),
              reason,
              id,
            ),
            env.DB.prepare(
              'UPDATE rpm_stages SET status=?,scheduled_count=?,attempted_count=?,success_count=?,rate_limited_count=?,client_error_count=?,server_error_count=?,timeout_count=?,transport_error_count=?,malformed_count=?,finished_at=?,dispatch_valid=? WHERE run_id=? AND stage_index=0',
            ).bind(
              status,
              metrics.sent,
              metrics.sent,
              counts.succeeded,
              counts.rateLimited,
              counts.clientErrors,
              counts.serverErrors,
              counts.timeouts,
              counts.transportErrors,
              counts.malformed,
              Date.now(),
              measured.failed ? 0 : 1,
              id,
            ),
            env.DB.prepare('DELETE FROM rpm_run_secrets WHERE run_id=?').bind(
              id,
            ),
            env.DB.prepare('DELETE FROM rpm_active_leases WHERE run_id=?').bind(
              id,
            ),
          ]);
          send({ type: 'done', metrics, status, reason });
        } catch {
          abort.abort();
          await env.DB.batch([
            env.DB.prepare(
              "UPDATE rpm_runs SET status='inconclusive',finished_at=?,stop_reason='The measurement stopped before final evidence was saved.' WHERE id=? AND status='running'",
            ).bind(Date.now(), id),
            env.DB.prepare('DELETE FROM rpm_run_secrets WHERE run_id=?').bind(
              id,
            ),
            env.DB.prepare('DELETE FROM rpm_active_leases WHERE run_id=?').bind(
              id,
            ),
          ]).catch(() => {});
          send({
            type: 'error',
            error:
              'The measurement stopped unexpectedly. Saved partial evidence is available in history.',
          });
        } finally {
          if (timer) clearInterval(timer);
          request.signal.removeEventListener('abort', onAbort);
          if (!closed)
            try {
              controller.close();
            } catch {}
        }
      },
      cancel() {
        abort.abort();
      },
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    return serverError(error);
  }
}
