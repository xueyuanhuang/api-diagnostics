import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getDb } from '@/db';
import { rpmRuns } from '@/db/schema';
import type { RpmPreflightSummary } from '@/lib/rpm-types';
import { noStore, serverError } from '@/lib/server/http';
import type { RpmRequestEvidence } from '@/lib/server/rpm-provider';
import { listR2Keys, runDetail } from '@/lib/server/rpm-store';

type Context = { params: Promise<{ id: string }> };

function preflightSummary(evidence: RpmRequestEvidence): RpmPreflightSummary {
  return {
    outcome: evidence.outcome,
    httpStatus: evidence.response.status,
    firstByteMs: evidence.firstByteMs,
    totalTimeMs: evidence.totalTimeMs,
    requestId: evidence.response.requestId,
    returnedModel: evidence.response.returnedModel,
    error: evidence.error,
  };
}

export async function GET(_request: NextRequest, context: Context) {
  const user = await getChatGPTUser();
  if (!user)
    return noStore({ error: 'Sign in to view this RPM run.' }, { status: 401 });
  const { id } = await context.params;
  try {
    const rows = await getDb()
      .select()
      .from(rpmRuns)
      .where(and(eq(rpmRuns.id, id), eq(rpmRuns.userId, user.userId)))
      .limit(1);
    if (!rows.length)
      return noStore({ error: 'RPM run not found.' }, { status: 404 });
    let preflight: RpmPreflightSummary | null = null;
    const object = await env.EVIDENCE.get(`rpm/v1/${id}/preflight.json`);
    if (object) {
      try {
        preflight = preflightSummary(
          JSON.parse(await object.text()) as RpmRequestEvidence,
        );
      } catch {
        preflight = null;
      }
    }
    return noStore({ ...(await runDetail(rows[0])), preflight });
  } catch (error) {
    return serverError(error);
  }
}

export async function DELETE(_request: NextRequest, context: Context) {
  const user = await getChatGPTUser();
  if (!user)
    return noStore(
      { error: 'Sign in to delete this RPM run.' },
      { status: 401 },
    );
  const { id } = await context.params;
  try {
    const rows = await getDb()
      .select({
        id: rpmRuns.id,
        status: rpmRuns.status,
        finishedAt: rpmRuns.finishedAt,
      })
      .from(rpmRuns)
      .where(and(eq(rpmRuns.id, id), eq(rpmRuns.userId, user.userId)))
      .limit(1);
    if (!rows.length)
      return noStore({ error: 'RPM run not found.' }, { status: 404 });
    if (['preflight', 'ready', 'running'].includes(rows[0].status)) {
      return noStore(
        { error: 'Cancel this active RPM run before deleting it.' },
        { status: 409 },
      );
    }
    if (
      rows[0].status === 'cancelled' &&
      rows[0].finishedAt !== null &&
      Date.now() - rows[0].finishedAt < 60_000
    ) {
      return noStore(
        {
          error:
            'This run was just cancelled. Wait one minute for in-flight requests to settle before deleting it.',
        },
        { status: 409 },
      );
    }
    const keys = await listR2Keys(env.EVIDENCE, `rpm/v1/${id}/`);
    for (let index = 0; index < keys.length; index += 1_000) {
      await env.EVIDENCE.delete(keys.slice(index, index + 1_000));
    }
    await env.DB.prepare('DELETE FROM rpm_runs WHERE id = ? AND user_id = ?')
      .bind(id, user.userId)
      .run();
    return noStore({ deleted: true });
  } catch (error) {
    return serverError(error);
  }
}
