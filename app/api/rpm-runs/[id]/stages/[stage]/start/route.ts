import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getDb } from '@/db';
import { rpmRuns, rpmStages } from '@/db/schema';
import { RPM_MAX_DISPATCH_SHARDS } from '@/lib/rpm-types';
import { noStore, serverError } from '@/lib/server/http';
import { stageSummary } from '@/lib/server/rpm-store';

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
    const runs = await getDb()
      .select()
      .from(rpmRuns)
      .where(and(eq(rpmRuns.id, id), eq(rpmRuns.userId, user.userId)))
      .limit(1);
    if (!runs.length)
      return noStore({ error: 'RPM run not found.' }, { status: 404 });
    if (!['ready', 'running'].includes(runs[0].status))
      return noStore(
        { error: `This run is already ${runs[0].status}.` },
        { status: 409 },
      );

    const stages = await getDb()
      .select()
      .from(rpmStages)
      .where(eq(rpmStages.runId, id));
    const current = stages.find((item) => item.stageIndex === stageIndex);
    if (!current)
      return noStore({ error: 'RPM stage not found.' }, { status: 404 });
    if (
      !Number.isInteger(current.batchCount) ||
      current.batchCount < 1 ||
      current.batchCount > RPM_MAX_DISPATCH_SHARDS
    ) {
      return noStore(
        {
          error:
            'This saved run uses an unsupported dispatcher layout. Cancel it and start a new RPM run.',
        },
        { status: 409 },
      );
    }
    if (current.status !== 'pending')
      return noStore(
        { error: `This stage is already ${current.status}.` },
        { status: 409 },
      );
    if (
      stageIndex > 0 &&
      stages.find((item) => item.stageIndex === stageIndex - 1)?.status !==
        'passed'
    ) {
      return noStore(
        { error: 'The previous stage has not passed.' },
        { status: 409 },
      );
    }

    const now = Date.now();
    const transitions = await env.DB.batch([
      env.DB.prepare(
        "UPDATE rpm_stages SET status = 'running', scheduled_start_at = NULL, started_at = ? WHERE run_id = ? AND stage_index = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM rpm_runs WHERE id = ? AND user_id = ? AND status IN ('ready', 'running'))",
      ).bind(now, id, stageIndex, id, user.userId),
      env.DB.prepare(
        "UPDATE rpm_runs SET status = 'running', current_stage = ? WHERE id = ? AND user_id = ? AND status IN ('ready', 'running')",
      ).bind(stageIndex, id, user.userId),
      env.DB.prepare(
        "UPDATE rpm_active_leases SET expires_at = ? WHERE user_id = ? AND run_id = ? AND EXISTS (SELECT 1 FROM rpm_runs WHERE id = ? AND user_id = ? AND status = 'running')",
      ).bind(now + 2 * 60 * 60 * 1_000, user.userId, id, id, user.userId),
    ]);
    if (!transitions[0].meta.changes)
      return noStore(
        { error: 'This stage could not start because the run changed state.' },
        { status: 409 },
      );
    const rows = await getDb()
      .select()
      .from(rpmStages)
      .where(and(eq(rpmStages.runId, id), eq(rpmStages.stageIndex, stageIndex)))
      .limit(1);
    return noStore({
      stage: stageSummary(rows[0]),
      shardCount: rows[0].batchCount,
    });
  } catch (error) {
    return serverError(error);
  }
}
