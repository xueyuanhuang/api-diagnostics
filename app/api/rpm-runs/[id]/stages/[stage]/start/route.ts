import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getDb } from '@/db';
import { rpmRuns, rpmStages } from '@/db/schema';
import { rpmBatchSize } from '@/lib/rpm-types';
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
    const scheduledStartAt = now + 2_000;
    const updated = await env.DB.prepare(
      "UPDATE rpm_stages SET status = 'running', scheduled_start_at = ?, started_at = ? WHERE run_id = ? AND stage_index = ? AND status = 'pending'",
    )
      .bind(scheduledStartAt, now, id, stageIndex)
      .run();
    if (!updated.meta.changes)
      return noStore(
        { error: 'This stage was already started.' },
        { status: 409 },
      );
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE rpm_runs SET status = 'running', current_stage = ? WHERE id = ?",
      ).bind(stageIndex, id),
      env.DB.prepare(
        'UPDATE rpm_active_leases SET expires_at = ? WHERE user_id = ? AND run_id = ?',
      ).bind(now + 2 * 60 * 60 * 1_000, user.userId, id),
    ]);
    const rows = await getDb()
      .select()
      .from(rpmStages)
      .where(and(eq(rpmStages.runId, id), eq(rpmStages.stageIndex, stageIndex)))
      .limit(1);
    return noStore({
      stage: stageSummary(rows[0]),
      batchSize: rpmBatchSize(
        rows[0].scheduledCount,
        runs[0].stageDurationSeconds,
      ),
    });
  } catch (error) {
    return serverError(error);
  }
}
