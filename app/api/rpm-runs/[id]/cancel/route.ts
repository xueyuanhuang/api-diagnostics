import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getDb } from '@/db';
import { rpmRuns } from '@/db/schema';
import { noStore, serverError } from '@/lib/server/http';
import { runDetail } from '@/lib/server/rpm-store';

type Context = { params: Promise<{ id: string }> };

export async function POST(_request: NextRequest, context: Context) {
  const user = await getChatGPTUser();
  if (!user)
    return noStore({ error: 'Sign in to cancel this run.' }, { status: 401 });
  const { id } = await context.params;
  try {
    const rows = await getDb()
      .select()
      .from(rpmRuns)
      .where(and(eq(rpmRuns.id, id), eq(rpmRuns.userId, user.userId)))
      .limit(1);
    if (!rows.length)
      return noStore({ error: 'RPM run not found.' }, { status: 404 });
    if (!['preflight', 'ready', 'running'].includes(rows[0].status))
      return noStore(await runDetail(rows[0]));
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE rpm_runs SET status = 'cancelled', stop_reason = 'Cancelled by the user. Export contains partial evidence only.', finished_at = ? WHERE id = ?",
      ).bind(now, id),
      env.DB.prepare(
        "UPDATE rpm_stages SET status = 'cancelled', finished_at = ? WHERE run_id = ? AND status = 'running'",
      ).bind(now, id),
      env.DB.prepare(
        "UPDATE rpm_stages SET status = 'skipped' WHERE run_id = ? AND status = 'pending'",
      ).bind(id),
      env.DB.prepare('DELETE FROM rpm_run_secrets WHERE run_id = ?').bind(id),
      env.DB.prepare(
        'DELETE FROM rpm_active_leases WHERE user_id = ? AND run_id = ?',
      ).bind(user.userId, id),
    ]);
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
