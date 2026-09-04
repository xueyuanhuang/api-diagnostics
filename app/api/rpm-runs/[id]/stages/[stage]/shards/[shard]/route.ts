import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getDb } from '@/db';
import { rpmRunSecrets, rpmRuns, rpmStages } from '@/db/schema';
import {
  maximumDispatchLagMs,
  plannedRequestAt,
  sequencesForShard,
} from '@/lib/rpm-dispatch';
import {
  RPM_MAX_DISPATCH_SHARDS,
  RPM_MAX_PROVIDER_CALLS_PER_SHARD,
  RPM_REQUEST_TIMEOUT_MS,
} from '@/lib/rpm-types';
import { decryptApiKey } from '@/lib/server/encryption';
import {
  countRpmOutcomes,
  type RpmOutcomeSummary,
} from '@/lib/server/rpm-evidence';
import { noStore, serverError } from '@/lib/server/http';
import {
  missedDispatchEvidence,
  runProviderRequest,
  type RpmRequestEvidence,
} from '@/lib/server/rpm-provider';

const ARM_WAIT_LIMIT_MS = 60_000;
const ARM_POLL_MS = 500;

type Context = {
  params: Promise<{ id: string; stage: string; shard: string }>;
};

type CompactEvidence = Pick<
  RpmRequestEvidence,
  | 'runId'
  | 'stageIndex'
  | 'sequence'
  | 'outcome'
  | 'totalTimeMs'
  | 'scheduleLagMs'
> & { verdictEligible: boolean };

type DispatcherManifest = {
  runId: string;
  stageIndex: number;
  shardIndex: number;
  shardCount: number;
  workerReceivedAt: number;
  readyAt: number;
  sequenceCount: number;
  complete: boolean;
  failed: boolean;
  finishedAt: number | null;
  error: string | null;
  requests: CompactEvidence[];
};

type StreamEvent =
  | { type: 'ready'; shardIndex: number; sequenceCount: number }
  | {
      type: 'request';
      shardIndex: number;
      sequence: number;
      summary: RpmOutcomeSummary;
    }
  | { type: 'dispatched'; shardIndex: number; sequence: number }
  | { type: 'complete'; shardIndex: number; summary: RpmOutcomeSummary }
  | { type: 'error'; shardIndex: number; error: string };

function encodeEvent(encoder: TextEncoder, event: StreamEvent) {
  return encoder.encode(JSON.stringify(event) + '\n');
}

function compactEvidence(
  result: RpmRequestEvidence,
  verdictEligible: boolean,
): CompactEvidence {
  return {
    runId: result.runId,
    stageIndex: result.stageIndex,
    sequence: result.sequence,
    outcome: result.outcome,
    totalTimeMs: result.totalTimeMs,
    scheduleLagMs: result.scheduleLagMs,
    verdictEligible,
  };
}

export async function POST(request: NextRequest, context: Context) {
  const workerReceivedAt = Date.now();
  const user = await getChatGPTUser();
  if (!user)
    return noStore({ error: 'Sign in to continue this run.' }, { status: 401 });
  const { id, stage, shard } = await context.params;
  const stageIndex = Number(stage);
  const shardIndex = Number(shard);
  if (
    !Number.isInteger(stageIndex) ||
    stageIndex < 0 ||
    !Number.isInteger(shardIndex) ||
    shardIndex < 0
  ) {
    return noStore(
      { error: 'Invalid stage or dispatcher shard.' },
      { status: 400 },
    );
  }

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
      return noStore({ error: 'Active RPM stage not found.' }, { status: 404 });
    const { run, stage: stageRow, secret } = rows[0];
    if (
      run.status !== 'running' ||
      run.currentStage !== stageIndex ||
      stageRow.status !== 'running'
    ) {
      return noStore(
        { error: 'This RPM stage is not accepting dispatchers.' },
        { status: 409 },
      );
    }

    const shardCount = stageRow.batchCount;
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
    if (shardIndex >= shardCount)
      return noStore(
        { error: 'Dispatcher shard is outside this stage.' },
        { status: 400 },
      );

    const sequences = sequencesForShard(
      stageRow.scheduledCount,
      shardIndex,
      shardCount,
    );
    const stagePart = String(stageIndex).padStart(2, '0');
    const shardPart = String(shardIndex).padStart(3, '0');
    const claimKey =
      'rpm/v1/' + id + '/claims/s' + stagePart + '/shard-' + shardPart;
    const claimed = await env.EVIDENCE.put(claimKey, String(workerReceivedAt), {
      onlyIf: { etagDoesNotMatch: '*' },
    });
    if (!claimed)
      return noStore(
        { error: 'This server dispatcher was already started.' },
        { status: 409 },
      );

    const apiKey = await decryptApiKey(secret.encryptedApiKey, secret.keyIv);
    const readyAt = Date.now();
    const readyKey =
      'rpm/v1/' +
      id +
      '/dispatchers/s' +
      stagePart +
      '/shard-' +
      shardPart +
      '.ready';
    const failureKey =
      'rpm/v1/' +
      id +
      '/dispatcher-failures/s' +
      stagePart +
      '/shard-' +
      shardPart +
      '.json';
    const initialManifest: DispatcherManifest = {
      runId: id,
      stageIndex,
      shardIndex,
      shardCount,
      workerReceivedAt,
      readyAt,
      sequenceCount: sequences.length,
      complete: false,
      failed: false,
      finishedAt: null,
      error: null,
      requests: [],
    };
    const initialReadyObject = await env.EVIDENCE.put(
      readyKey,
      JSON.stringify(initialManifest),
      {
        httpMetadata: { contentType: 'application/json' },
      },
    );
    if (!initialReadyObject)
      throw new Error('Could not create the dispatcher readiness manifest.');
    const initialReadyEtag = initialReadyObject.etag;
    const storeTerminalManifest = async (manifest: DispatcherManifest) => {
      const stored = await env.EVIDENCE.put(
        readyKey,
        JSON.stringify(manifest),
        {
          httpMetadata: { contentType: 'application/json' },
          onlyIf: { etagMatches: initialReadyEtag },
        },
      );
      if (stored) return;
      const existing = await env.EVIDENCE.get(readyKey);
      const parsed = existing
        ? (JSON.parse(await existing.text()) as DispatcherManifest)
        : null;
      if (
        parsed?.runId !== id ||
        parsed.stageIndex !== stageIndex ||
        parsed.shardIndex !== shardIndex ||
        parsed.complete !== true
      ) {
        throw new Error('The dispatcher manifest changed unexpectedly.');
      }
    };

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const emit = (event: StreamEvent) => {
          try {
            controller.enqueue(encodeEvent(encoder, event));
          } catch {
            // Evidence remains canonical if the browser progress stream closes.
          }
        };
        emit({
          type: 'ready',
          shardIndex,
          sequenceCount: sequences.length,
        });
        const evidence: CompactEvidence[] = [];

        void (async () => {
          let saveQueue: Promise<void> = Promise.resolve();

          const stageState = () =>
            env.DB.prepare(
              'SELECT r.status AS run_status, r.current_stage AS current_stage, s.status AS stage_status, s.scheduled_start_at AS scheduled_start_at, s.finished_at AS finished_at FROM rpm_runs r INNER JOIN rpm_stages s ON s.run_id = r.id WHERE r.id = ? AND r.user_id = ? AND s.stage_index = ?',
            )
              .bind(id, user.userId, stageIndex)
              .first<{
                run_status: string;
                current_stage: number | null;
                stage_status: string;
                scheduled_start_at: number | null;
                finished_at: number | null;
              }>();
          const stageIsActive = (
            state: Awaited<ReturnType<typeof stageState>>,
          ) =>
            state?.run_status === 'running' &&
            state.current_stage === stageIndex &&
            state.stage_status === 'running';
          const stageAcceptsTerminalManifest = (
            state: Awaited<ReturnType<typeof stageState>>,
          ) =>
            state?.run_status === 'running' &&
            state.current_stage === stageIndex &&
            ['running', 'finalizing'].includes(state.stage_status);

          const persist = async (
            result: RpmRequestEvidence,
            options: {
              verdictEligible?: boolean;
              verdictExclusionReason?: string | null;
            } = {},
          ) => {
            const verdictEligible = options.verdictEligible ?? true;
            const resultKey =
              'rpm/v1/' +
              id +
              '/results/s' +
              stagePart +
              '/request-' +
              String(result.sequence).padStart(6, '0') +
              '.json';
            let canonical = result;
            const operation = saveQueue
              .catch(() => undefined)
              .then(async () => {
                const saved = await env.EVIDENCE.put(
                  resultKey,
                  JSON.stringify({
                    runId: id,
                    stageIndex,
                    batchIndex: shardIndex,
                    shardIndex,
                    shardCount,
                    firstSequence: sequences[0] ?? null,
                    dispatchMode: 'server-timed-shard-v1',
                    workerReceivedAt,
                    readyAt,
                    sequence: result.sequence,
                    verdictEligible,
                    verdictExclusionReason:
                      options.verdictExclusionReason ?? null,
                    summary: countRpmOutcomes([result]),
                    requests: [result],
                  }),
                  {
                    httpMetadata: { contentType: 'application/json' },
                    onlyIf: { etagDoesNotMatch: '*' },
                  },
                );
                if (!saved) {
                  const existing = await env.EVIDENCE.get(resultKey);
                  const parsed = existing
                    ? (JSON.parse(await existing.text()) as {
                        requests?: RpmRequestEvidence[];
                      })
                    : null;
                  const stored = parsed?.requests?.[0];
                  if (
                    !stored ||
                    stored.runId !== id ||
                    stored.stageIndex !== stageIndex ||
                    stored.sequence !== result.sequence
                  ) {
                    throw new Error(
                      'Canonical evidence already exists but could not be validated.',
                    );
                  }
                  canonical = stored;
                }
                evidence.push(compactEvidence(canonical, verdictEligible));
              });
            saveQueue = operation.then(() => undefined);
            await operation;
            emit({
              type: 'request',
              shardIndex,
              sequence: canonical.sequence,
              summary: countRpmOutcomes([canonical]),
            });
          };

          const armWaitStartedAt = Date.now();
          let scheduledStartAt: number | null = stageRow.scheduledStartAt;
          while (scheduledStartAt === null) {
            if (request.signal.aborted)
              throw new DOMException('Aborted', 'AbortError');
            const state = await stageState();
            if (!state || !stageIsActive(state)) {
              emit({
                type: 'complete',
                shardIndex,
                summary: countRpmOutcomes(evidence),
              });
              controller.close();
              return;
            }
            scheduledStartAt = state.scheduled_start_at;
            if (scheduledStartAt !== null) break;
            if (Date.now() - armWaitStartedAt >= ARM_WAIT_LIMIT_MS)
              throw new Error(
                'The server dispatch readiness barrier timed out.',
              );
            await scheduler.wait(ARM_POLL_MS, { signal: request.signal });
          }

          const maximumLagMs = maximumDispatchLagMs(
            stageRow.scheduledCount,
            run.stageDurationSeconds,
          );
          let reservedProviderSlots = 0;
          const settled = await Promise.allSettled(
            sequences.map(async (sequence) => {
              const plannedAt = plannedRequestAt(
                scheduledStartAt!,
                sequence,
                stageRow.scheduledCount,
                run.stageDurationSeconds,
              );
              const waitMs = plannedAt - Date.now();
              if (waitMs > 0)
                await scheduler.wait(waitMs, { signal: request.signal });
              const schedulerWokeAt = Date.now();
              const common = {
                apiType: run.apiType,
                baseUrl: run.baseUrl,
                apiKey,
                model: run.modelName,
                runId: id,
                stageIndex,
                sequence,
                plannedAt,
                timeoutMs: RPM_REQUEST_TIMEOUT_MS,
                onUpstreamStarted: async (upstreamStartedAt: number) => {
                  const dispatchStartKey =
                    'rpm/v1/' +
                    id +
                    '/dispatch-starts/s' +
                    stagePart +
                    '/request-' +
                    String(sequence).padStart(6, '0') +
                    '.json';
                  try {
                    await env.EVIDENCE.put(
                      dispatchStartKey,
                      JSON.stringify({
                        runId: id,
                        stageIndex,
                        sequence,
                        upstreamStartedAt,
                      }),
                      {
                        httpMetadata: { contentType: 'application/json' },
                        onlyIf: { etagDoesNotMatch: '*' },
                      },
                    );
                  } finally {
                    emit({ type: 'dispatched', shardIndex, sequence });
                  }
                },
                dispatcher: {
                  mode: 'server-timed-shard-v1' as const,
                  shardIndex,
                  shardCount,
                  workerReceivedAt,
                  readyAt,
                  schedulerWokeAt,
                },
              };

              const state = await stageState();
              if (!stageIsActive(state)) return;

              const lagMs = Date.now() - plannedAt;
              if (lagMs > maximumLagMs) {
                await persist(
                  missedDispatchEvidence(
                    common,
                    'Server dispatch arrived ' +
                      lagMs +
                      ' ms late; the ' +
                      maximumLagMs +
                      ' ms no-catch-up limit was exceeded.',
                  ),
                );
                return;
              }

              if (
                reservedProviderSlots >= RPM_MAX_PROVIDER_CALLS_PER_SHARD
              ) {
                await persist(
                  missedDispatchEvidence(
                    common,
                    `The server shard had ${RPM_MAX_PROVIDER_CALLS_PER_SHARD} outstanding provider calls, so this slot was not sent or silently queued.`,
                  ),
                );
                return;
              }
              reservedProviderSlots += 1;
              try {
                const requestPart = String(sequence).padStart(6, '0');
                const upstreamClaimKey =
                  'rpm/v1/' +
                  id +
                  '/upstream-claims/s' +
                  stagePart +
                  '/request-' +
                  requestPart;
                const upstreamClaim = await env.EVIDENCE.put(
                  upstreamClaimKey,
                  JSON.stringify({
                    runId: id,
                    stageIndex,
                    sequence,
                    claimedAt: Date.now(),
                  }),
                  { onlyIf: { etagDoesNotMatch: '*' } },
                );
                if (!upstreamClaim)
                  throw new Error(
                    'Upstream request ' +
                      (sequence + 1) +
                      ' was already claimed; it was not sent twice.',
                  );

                const activeBeforeSend = await stageState();
                if (!stageIsActive(activeBeforeSend)) return;

                const finalLagMs = Date.now() - plannedAt;
                if (finalLagMs > maximumLagMs) {
                  await persist(
                    missedDispatchEvidence(
                      common,
                      'Server dispatch arrived ' +
                        finalLagMs +
                        ' ms late after its safety checks; the ' +
                        maximumLagMs +
                        ' ms no-catch-up limit was exceeded.',
                    ),
                  );
                  return;
                }

                const result = await runProviderRequest(common);
                let activeAfterResponse: Awaited<
                  ReturnType<typeof stageState>
                > = null;
                let stateReadError = false;
                try {
                  activeAfterResponse = await stageState();
                } catch {
                  stateReadError = true;
                }
                const completedBeforeFreeze =
                  activeAfterResponse?.stage_status === 'finalizing' &&
                  activeAfterResponse.finished_at !== null &&
                  result.completedAt <= activeAfterResponse.finished_at;
                const verdictEligible =
                  !stateReadError &&
                  (stageIsActive(activeAfterResponse) || completedBeforeFreeze);
                await persist(result, {
                  verdictEligible,
                  verdictExclusionReason: verdictEligible
                    ? null
                    : stateReadError
                      ? 'The response was preserved, but the tester could not verify its stage state after completion.'
                      : 'The response completed after the stage evidence was frozen or cancelled.',
                });
              } finally {
                reservedProviderSlots -= 1;
              }
            }),
          );
          await saveQueue.catch(() => undefined);

          const taskErrors = settled.filter(
            (result): result is PromiseRejectedResult =>
              result.status === 'rejected',
          );
          const finalState = await stageState();
          if (!stageAcceptsTerminalManifest(finalState)) {
            try {
              controller.close();
            } catch {
              // The browser progress stream has already closed.
            }
            return;
          }

          const manifestError = taskErrors.length
            ? String(taskErrors.length) +
              ' dispatcher task' +
              (taskErrors.length === 1 ? '' : 's') +
              ' failed before evidence was safely completed.'
            : null;
          const finalManifest: DispatcherManifest = {
            ...initialManifest,
            complete: true,
            failed: taskErrors.length > 0,
            finishedAt: Date.now(),
            error: manifestError,
            requests: evidence,
          };
          await storeTerminalManifest(finalManifest);

          if (manifestError) {
            emit({ type: 'error', shardIndex, error: manifestError });
          } else {
            emit({
              type: 'complete',
              shardIndex,
              summary: countRpmOutcomes(evidence),
            });
          }
          try {
            controller.close();
          } catch {
            // The browser progress stream has already closed.
          }
        })().catch(async (dispatcherError: unknown) => {
          const dispatcherErrorMessage =
            dispatcherError instanceof Error
              ? dispatcherError.message
              : typeof dispatcherError === 'string' && dispatcherError
                ? dispatcherError
                : 'Unknown dispatcher error.';
          try {
            const state = await env.DB.prepare(
              'SELECT r.status AS run_status, r.current_stage AS current_stage, s.status AS stage_status FROM rpm_runs r INNER JOIN rpm_stages s ON s.run_id = r.id WHERE r.id = ? AND r.user_id = ? AND s.stage_index = ?',
            )
              .bind(id, user.userId, stageIndex)
              .first<{
                run_status: string;
                current_stage: number | null;
                stage_status: string;
              }>();
            if (
              state?.run_status === 'running' &&
              state.current_stage === stageIndex &&
              ['running', 'finalizing'].includes(state.stage_status)
            ) {
              await env.EVIDENCE.put(
                failureKey,
                JSON.stringify({
                  runId: id,
                  stageIndex,
                  shardIndex,
                  failedAt: Date.now(),
                  error: dispatcherErrorMessage,
                }),
                { httpMetadata: { contentType: 'application/json' } },
              );
              await env.EVIDENCE.put(
                readyKey,
                JSON.stringify({
                  ...initialManifest,
                  complete: true,
                  failed: true,
                  finishedAt: Date.now(),
                  error: dispatcherErrorMessage,
                  requests: evidence,
                } satisfies DispatcherManifest),
                {
                  httpMetadata: { contentType: 'application/json' },
                  onlyIf: { etagMatches: initialReadyEtag },
                },
              );
            }
          } catch {
            // Finalization treats a missing terminal manifest as inconclusive.
          }
          try {
            controller.enqueue(
              encodeEvent(encoder, {
                type: 'error',
                shardIndex,
                error: dispatcherErrorMessage,
              }),
            );
            controller.close();
          } catch {
            // The browser disconnected; persisted evidence remains canonical.
          }
        });
      },
    });

    return new Response(stream, {
      headers: {
        'cache-control': 'private, no-store',
        'content-type': 'application/x-ndjson; charset=utf-8',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (error) {
    return serverError(error);
  }
}
