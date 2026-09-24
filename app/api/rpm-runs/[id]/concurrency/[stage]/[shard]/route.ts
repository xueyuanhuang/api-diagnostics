import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getDb } from '@/db';
import { rpmRuns, rpmStages, rpmRunSecrets } from '@/db/schema';
import {
  concurrencyPlan,
  concurrencyLevelsForRun,
  concurrencyModeForRun,
  concurrencyStopsAfter,
  CONCURRENCY_MAX_LEVELS,
  concurrencyUsesStreaming,
  CONCURRENCY_WINDOW_MS,
  CONCURRENCY_CHUNK_SIZE,
  runConcurrencyChunk,
  type ConcurrencyManifest,
  type ConcurrencySample,
} from '@/lib/concurrency-test';
import { decryptApiKey } from '@/lib/server/encryption';
import { loadRpmConnection } from '@/lib/server/hosted-ip-mapping';
import { runProviderRequest } from '@/lib/server/rpm-provider';
import { noStore, serverError } from '@/lib/server/http';

type Context = {
  params: Promise<{ id: string; stage: string; shard: string }>;
};
export async function POST(request: NextRequest, context: Context) {
  const user = await getChatGPTUser();
  if (!user)
    return noStore(
      { error: 'Sign in to continue this test.' },
      { status: 401 },
    );
  if (
    request.headers.get('origin') &&
    request.headers.get('origin') !== new URL(request.url).origin
  )
    return noStore({ error: 'Invalid origin.' }, { status: 403 });
  const { id, stage, shard } = await context.params;
  const stageIndex = Number(stage),
    shardIndex = Number(shard);
  let chunk: number;
  try {
    chunk = ((await request.json()) as { chunk: number }).chunk;
  } catch {
    return noStore({ error: 'Invalid chunk.' }, { status: 400 });
  }
  if (
    ![stageIndex, shardIndex, chunk].every(Number.isInteger) ||
    stageIndex < 0 ||
    stageIndex >= CONCURRENCY_MAX_LEVELS ||
    shardIndex < 0 ||
    chunk < 0
  )
    return noStore({ error: 'Invalid dispatcher.' }, { status: 400 });
  try {
    const rows = await getDb()
      .select({ run: rpmRuns, stage: rpmStages, secret: rpmRunSecrets })
      .from(rpmRuns)
      .innerJoin(rpmStages, eq(rpmStages.runId, rpmRuns.id))
      .innerJoin(rpmRunSecrets, eq(rpmRunSecrets.runId, rpmRuns.id))
      .where(
        and(
          eq(rpmRuns.id, id),
          eq(rpmRuns.userId, user.userId),
          eq(rpmStages.stageIndex, stageIndex),
        ),
      )
      .limit(1);
    if (!rows.length)
      return noStore({ error: 'Test not found.' }, { status: 404 });
    const { run, stage: row, secret } = rows[0];
    if (
      run.rampMode !== 'concurrency' ||
      run.status !== 'running' ||
      run.currentStage !== stageIndex ||
      row.status !== 'running'
    )
      return noStore({ error: 'This level is not running.' }, { status: 409 });
    const levels = concurrencyLevelsForRun(run.automaticMetricsJson);
    const mode = concurrencyModeForRun(run.automaticMetricsJson);
    if (stageIndex >= levels.length)
      return noStore({ error: 'Invalid concurrency level.' }, { status: 400 });
    const plan = concurrencyPlan(stageIndex, levels);
    const shardPlan = plan.shardPlans[shardIndex];
    if (
      !shardPlan ||
      chunk >= Math.ceil(shardPlan.requestCap / CONCURRENCY_CHUNK_SIZE)
    )
      return noStore({ error: 'Outside the test budget.' }, { status: 400 });
    const part = String(stageIndex).padStart(2, '0'),
      shardPart = String(shardIndex).padStart(3, '0');
    const root = `rpm/v1/${id}`;
    const readyKey = `${root}/dispatchers/s${part}/shard-${shardPart}.ready`;
    let previous: ConcurrencyManifest | null = null;
    if (chunk) {
      const object = await env.EVIDENCE.get(
        `${root}/concurrency/s${part}/shard-${shardPart}/chunk-${chunk - 1}.json`,
      );
      previous = object ? await object.json<ConcurrencyManifest>() : null;
      if (
        !previous ||
        previous.nextChunk !== chunk ||
        previous.failed ||
        previous.stageIndex !== stageIndex ||
        previous.shardIndex !== shardIndex
      )
        return noStore(
          { error: 'Missing or finished continuation.' },
          { status: 409 },
        );
    }
    const connection = await loadRpmConnection(id, run.baseUrl);
    const apiKey = await decryptApiKey(secret.encryptedApiKey, secret.keyIv);
    const claim = await env.EVIDENCE.put(
      `${root}/claims/s${part}/concurrency-${shardPart}-${chunk}`,
      String(Date.now()),
      { onlyIf: { etagDoesNotMatch: '*' } },
    );
    if (!claim)
      return noStore(
        { error: 'This chunk already started. It will not be sent twice.' },
        { status: 409 },
      );
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    request.signal.addEventListener('abort', onAbort, { once: true });
    if (request.signal.aborted) abort.abort();
    let stopped = false,
      closed = false;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (event: unknown) => {
          if (!closed)
            try {
              controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
            } catch {
              closed = true;
              abort.abort();
            }
        };
        let timer: ReturnType<typeof setInterval> | undefined;
        let stateRead: Promise<void> = Promise.resolve();
        let busy = false;
        let terminalWritten = false;
        const state = () =>
          env.DB.prepare(
            'SELECT r.status AS run_status,r.stop_reason AS stop_reason,s.status AS stage_status,s.scheduled_start_at AS scheduled_start_at FROM rpm_runs r JOIN rpm_stages s ON s.run_id=r.id WHERE r.id=? AND s.stage_index=?',
          )
            .bind(id, stageIndex)
            .first<{
              run_status: string;
              stop_reason: string | null;
              stage_status: string;
              scheduled_start_at: number | null;
            }>();
        try {
          if (!chunk)
            await env.EVIDENCE.put(
              readyKey,
              JSON.stringify({ stageIndex, shardIndex, complete: false }),
            );
          emit({ type: 'ready', shardIndex });
          let startAt = row.scheduledStartAt;
          const prepareDeadline = Date.now() + 60_000;
          while (startAt === null) {
            if (abort.signal.aborted)
              throw new Error('Connection closed during preparation.');
            const current = await state();
            if (
              current?.run_status !== 'running' ||
              current.stage_status !== 'running'
            )
              throw new Error('Test stopped during preparation.');
            startAt = current.scheduled_start_at;
            if (Date.now() > prepareDeadline)
              throw new Error('Dispatchers were not armed in time.');
            if (startAt === null)
              await scheduler.wait(500, { signal: abort.signal });
          }
          if (startAt > Date.now())
            await scheduler.wait(startAt - Date.now(), {
              signal: abort.signal,
            });
          // Recheck after the common start barrier, before any paid request.
          const active = await state();
          if (
            active?.run_status !== 'running' ||
            active.stage_status !== 'running'
          )
            throw new Error('Test stopped before dispatch.');
          stopped = Boolean(active.stop_reason);
          timer = setInterval(() => {
            if (busy) return;
            busy = true;
            stateRead = (async () => {
              const current = await state();
              if (
                current?.run_status !== 'running' ||
                current.stage_status !== 'running'
              ) {
                stopped = true;
                abort.abort();
              } else if (current.stop_reason) stopped = true;
            })()
              .catch(() => {
                stopped = true;
                abort.abort();
              })
              .finally(() => {
                busy = false;
              });
            emit({ type: 'heartbeat', shardIndex });
          }, 1000);
          const offset = chunk * CONCURRENCY_CHUNK_SIZE;
          let publishStop: Promise<unknown> | null = null;
          const measured = await runConcurrencyChunk({
            start: startAt,
            deadline: startAt + CONCURRENCY_WINDOW_MS,
            first: offset,
            count: Math.min(
              CONCURRENCY_CHUNK_SIZE,
              shardPlan.requestCap - offset,
            ),
            concurrency: shardPlan.concurrency,
            mode,
            signal: abort.signal,
            stopped: () => stopped,
            request: (ordinal) =>
              runProviderRequest({
                apiType: run.apiType,
                baseUrl: connection.actualBaseUrl,
                originalBaseUrl: run.baseUrl,
                apiKey,
                model: run.modelName,
                openRouterTier: run.openRouterTier,
                runId: id,
                stageIndex,
                sequence: shardIndex + ordinal * plan.shards,
                plannedAt: Date.now(),
                timeoutMs: 20_000,
                stream: concurrencyUsesStreaming(run.automaticMetricsJson),
                signal: abort.signal,
              }),
            onResult: (sample) => {
              emit({ type: 'request', shardIndex, outcome: sample.outcome });
              if (concurrencyStopsAfter(sample.outcome, mode) && !publishStop) {
                stopped = true;
                publishStop = env.DB.prepare(
                  "UPDATE rpm_runs SET stop_reason=? WHERE id=? AND status='running' AND stop_reason IS NULL",
                )
                  .bind(
                    'A request failed during concurrency exploration; higher load was stopped.',
                    id,
                  )
                  .run()
                  .catch(() => {
                    abort.abort();
                  });
              }
            },
          });
          clearInterval(timer);
          await stateRead;
          if (publishStop) await publishStop;
          // Bounded raw evidence upload: no storage wait before replacing each request.
          await env.EVIDENCE.put(
            `${root}/results/s${part}/concurrency-${shardPart}-${chunk}.json`,
            JSON.stringify({
              dispatchMode: 'concurrency-shards-v1',
              verdictEligible: !abort.signal.aborted,
              requests: measured.samples,
            }),
            { httpMetadata: { contentType: 'application/json' } },
          );
          const compact: ConcurrencySample[] = measured.samples.map((s) => ({
            sequence: s.sequence,
            upstreamStartedAt: s.upstreamStartedAt,
            completedAt: s.completedAt,
            totalTimeMs: s.totalTimeMs,
            ttftMs: s.ttftMs ?? null,
            outcome: s.outcome,
            error: s.error,
          }));
          const samples = [...(previous?.samples ?? []), ...compact];
          const continueRun =
            !measured.failed &&
            !measured.stoppedAfterError &&
            !stopped &&
            Date.now() < startAt + CONCURRENCY_WINDOW_MS &&
            samples.length < shardPlan.requestCap;
          const manifest: ConcurrencyManifest = {
            stageIndex,
            shardIndex,
            complete: !continueRun,
            failed: measured.failed,
            finishedAt: Date.now(),
            nextChunk: continueRun ? chunk + 1 : null,
            samples,
          };
          await env.EVIDENCE.put(
            `${root}/concurrency/s${part}/shard-${shardPart}/chunk-${chunk}.json`,
            JSON.stringify(manifest),
          );
          await env.EVIDENCE.put(readyKey, JSON.stringify(manifest));
          terminalWritten = true;
          emit({
            type: continueRun ? 'continue' : 'complete',
            chunk: manifest.nextChunk,
            shardIndex,
          });
        } catch {
          stopped = true;
          abort.abort();
          if (!terminalWritten)
            await env.EVIDENCE.put(
              readyKey,
              JSON.stringify({
                stageIndex,
                shardIndex,
                complete: true,
                failed: true,
                finishedAt: Date.now(),
                nextChunk: null,
                samples: previous?.samples ?? [],
              } satisfies ConcurrencyManifest),
            ).catch(() => {});
          emit({
            type: 'error',
            error:
              'A test dispatcher stopped before its evidence was complete. Provider capacity is undetermined.',
          });
        } finally {
          if (timer) clearInterval(timer);
          await stateRead;
          request.signal.removeEventListener('abort', onAbort);
          if (!closed)
            try {
              controller.close();
            } catch {}
        }
      },
      cancel() {
        closed = true;
        abort.abort();
      },
    });
    return new Response(stream, {
      headers: {
        'content-type': 'application/x-ndjson',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (error) {
    return serverError(error);
  }
}
