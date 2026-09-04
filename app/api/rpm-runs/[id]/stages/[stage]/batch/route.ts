import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getDb } from '@/db';
import { rpmRunSecrets, rpmRuns, rpmStages } from '@/db/schema';
import { rpmBatchSize } from '@/lib/rpm-types';
import { decryptApiKey } from '@/lib/server/encryption';
import { noStore, serverError } from '@/lib/server/http';
import {
  missedDispatchEvidence,
  runProviderRequest,
  type RpmRequestEvidence,
} from '@/lib/server/rpm-provider';

type Context = { params: Promise<{ id: string; stage: string }> };
type Payload = { batchIndex?: unknown };

function countOutcomes(results: RpmRequestEvidence[]) {
  const count = (outcome: RpmRequestEvidence['outcome']) =>
    results.filter((result) => result.outcome === outcome).length;
  return {
    completed: results.length,
    attempted: results.length - count('missed_dispatch'),
    succeeded: count('success'),
    rateLimited: count('rate_limited'),
    clientErrors: count('client_error'),
    serverErrors: count('server_error'),
    timeouts: count('timeout'),
    transportErrors: count('transport_error'),
    malformed: count('malformed'),
    missedDispatch: count('missed_dispatch'),
  };
}

export async function POST(request: NextRequest, context: Context) {
  const user = await getChatGPTUser();
  if (!user)
    return noStore({ error: 'Sign in to continue this run.' }, { status: 401 });
  const { id, stage } = await context.params;
  const stageIndex = Number(stage);
  let payload: Payload;
  try {
    payload = (await request.json()) as Payload;
  } catch {
    return noStore({ error: 'Invalid request body.' }, { status: 400 });
  }
  const batchIndex = Number(payload.batchIndex);
  if (
    !Number.isInteger(stageIndex) ||
    stageIndex < 0 ||
    !Number.isInteger(batchIndex) ||
    batchIndex < 0
  ) {
    return noStore({ error: 'Invalid stage or batch.' }, { status: 400 });
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
    if (run.status !== 'running' || stageRow.status !== 'running') {
      return noStore(
        { error: 'This RPM stage is not accepting dispatches.' },
        { status: 409 },
      );
    }
    if (stageRow.scheduledStartAt === null)
      return noStore({ error: 'Stage schedule is missing.' }, { status: 409 });
    const batchSize = rpmBatchSize(
      stageRow.scheduledCount,
      run.stageDurationSeconds,
    );
    const firstSequence = batchIndex * batchSize;
    if (firstSequence >= stageRow.scheduledCount)
      return noStore(
        { error: 'Batch is outside this stage.' },
        { status: 400 },
      );

    const paddedBatch = String(batchIndex).padStart(6, '0');
    const claimKey = `rpm/v1/${id}/claims/s${String(stageIndex).padStart(2, '0')}/${paddedBatch}`;
    const claimed = await env.EVIDENCE.put(claimKey, String(Date.now()), {
      onlyIf: { etagDoesNotMatch: '*' },
    });
    if (!claimed)
      return noStore(
        { error: 'This batch was already dispatched.' },
        { status: 409 },
      );

    const apiKey = await decryptApiKey(secret.encryptedApiKey, secret.keyIv);
    const intervalMs =
      (run.stageDurationSeconds * 1_000) / stageRow.scheduledCount;
    const sequences = Array.from(
      {
        length: Math.min(batchSize, stageRow.scheduledCount - firstSequence),
      },
      (_, offset) => firstSequence + offset,
    );
    const results = await Promise.all(
      sequences.map(async (sequence) => {
        const plannedAt = Math.round(
          stageRow.scheduledStartAt! + sequence * intervalMs,
        );
        const waitMs = plannedAt - Date.now();
        if (waitMs > 0) await scheduler.wait(waitMs);
        const common = {
          apiType: run.apiType,
          baseUrl: run.baseUrl,
          apiKey,
          model: run.modelName,
          runId: id,
          stageIndex,
          sequence,
          plannedAt,
        };
        const currentRun = await env.DB.prepare(
          'SELECT status FROM rpm_runs WHERE id = ? AND user_id = ?',
        )
          .bind(id, user.userId)
          .first<{ status: string }>();
        if (currentRun?.status !== 'running') {
          return missedDispatchEvidence(
            common,
            'The run was cancelled or stopped before this upstream request began.',
          );
        }
        const lagMs = Date.now() - plannedAt;
        const maximumLagMs = Math.max(1_500, Math.round(intervalMs * 3));
        if (lagMs > maximumLagMs) {
          return missedDispatchEvidence(
            common,
            `Dispatch arrived ${lagMs} ms late; the ${maximumLagMs} ms no-catch-up limit was exceeded.`,
          );
        }
        return runProviderRequest(common);
      }),
    );
    results.sort((left, right) => left.sequence - right.sequence);
    const summary = countOutcomes(results);
    const resultKey = `rpm/v1/${id}/results/s${String(stageIndex).padStart(2, '0')}/${paddedBatch}.json`;
    await env.EVIDENCE.put(
      resultKey,
      JSON.stringify({
        runId: id,
        stageIndex,
        batchIndex,
        firstSequence,
        summary,
        requests: results,
      }),
      { httpMetadata: { contentType: 'application/json' } },
    );
    return noStore({ batchIndex, summary });
  } catch (error) {
    return serverError(error);
  }
}
