import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getDb } from '@/db';
import { rpmRuns, rpmStages } from '@/db/schema';
import { RPM_MAX_DISPATCH_SHARDS } from '@/lib/rpm-types';
import { noStore, serverError } from '@/lib/server/http';
import { listR2Keys, stageSummary } from '@/lib/server/rpm-store';

const ARM_LEAD_MS = 5_000;

type Context = { params: Promise<{ id: string; stage: string }> };

export async function POST(_request: NextRequest, context: Context) {
  const user = await getChatGPTUser();
  if (!user)
    return noStore({ error: 'Sign in to continue this run.' }, { status: 401 });
  const { id, stage } = await context.params;
  const stageIndex = Number(stage);
  if (!Number.isInteger(stageIndex) || stageIndex < 0)
    return noStore({ error: 'Invalid RPM stage.' }, { status: 400 });

  try {
    const rows = await getDb()
      .select({ run: rpmRuns, stage: rpmStages })
      .from(rpmRuns)
      .innerJoin(rpmStages, eq(rpmStages.runId, rpmRuns.id))
      .where(
        and(
          eq(rpmRuns.id, id),
          eq(rpmRuns.userId, user.userId),
          eq(rpmStages.stageIndex, stageIndex),
        ),
      )
      .limit(1);
    if (!rows.length)
      return noStore({ error: 'RPM stage not found.' }, { status: 404 });
    const { run, stage: stageRow } = rows[0];
    if (
      run.status !== 'running' ||
      run.currentStage !== stageIndex ||
      stageRow.status !== 'running'
    ) {
      return noStore(
        { error: 'This RPM stage cannot be armed.' },
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
    if (stageRow.scheduledStartAt !== null) {
      return noStore({ stage: stageSummary(stageRow), shardCount });
    }

    const stagePart = String(stageIndex).padStart(2, '0');
    const readyPrefix = `rpm/v1/${id}/dispatchers/s${stagePart}/`;
    const failurePrefix = `rpm/v1/${id}/dispatcher-failures/s${stagePart}/`;
    const failureKeys = await listR2Keys(env.EVIDENCE, failurePrefix);
    if (failureKeys.length) {
      return noStore(
        {
          error:
            'A server dispatcher stopped during preparation. No stage traffic was armed.',
        },
        { status: 409 },
      );
    }
    const readyKeys = new Set(await listR2Keys(env.EVIDENCE, readyPrefix));
    const allReady = Array.from({ length: shardCount }, (_, shardIndex) =>
      readyKeys.has(
        `${readyPrefix}shard-${String(shardIndex).padStart(3, '0')}.ready`,
      ),
    ).every(Boolean);
    if (!allReady) {
      return noStore(
        {
          error: `Server dispatchers are not ready (${readyKeys.size}/${shardCount}). No stage traffic was armed.`,
        },
        { status: 409 },
      );
    }

    const scheduledStartAt = Date.now() + ARM_LEAD_MS;
    const updated = await env.DB.prepare(
      "UPDATE rpm_stages SET scheduled_start_at = ? WHERE run_id = ? AND stage_index = ? AND status = 'running' AND scheduled_start_at IS NULL AND EXISTS (SELECT 1 FROM rpm_runs WHERE id = ? AND user_id = ? AND status = 'running')",
    )
      .bind(scheduledStartAt, id, stageIndex, id, user.userId)
      .run();
    if (!updated.meta.changes) {
      const latest = await getDb()
        .select({ run: rpmRuns, stage: rpmStages })
        .from(rpmRuns)
        .innerJoin(rpmStages, eq(rpmStages.runId, rpmRuns.id))
        .where(
          and(
            eq(rpmRuns.id, id),
            eq(rpmRuns.userId, user.userId),
            eq(rpmStages.stageIndex, stageIndex),
          ),
        )
        .limit(1);
      if (
        latest[0]?.run.status === 'running' &&
        latest[0].run.currentStage === stageIndex &&
        latest[0].stage.status === 'running' &&
        latest[0].stage.scheduledStartAt !== null
      ) {
        return noStore({ stage: stageSummary(latest[0].stage), shardCount });
      }
      return noStore(
        { error: 'The stage changed state before it could be armed.' },
        { status: 409 },
      );
    }

    const armed = await getDb()
      .select()
      .from(rpmStages)
      .where(and(eq(rpmStages.runId, id), eq(rpmStages.stageIndex, stageIndex)))
      .limit(1);
    return noStore({ stage: stageSummary(armed[0]), shardCount });
  } catch (error) {
    return serverError(error);
  }
}
