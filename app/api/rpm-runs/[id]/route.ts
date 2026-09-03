import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getDb } from '@/db';
import { rpmRuns } from '@/db/schema';
import { noStore, serverError } from '@/lib/server/http';
import { listR2Keys, runDetail } from '@/lib/server/rpm-store';

type Context = { params: Promise<{ id: string }> };

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
    return noStore(await runDetail(rows[0]));
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
      .select({ id: rpmRuns.id })
      .from(rpmRuns)
      .where(and(eq(rpmRuns.id, id), eq(rpmRuns.userId, user.userId)))
      .limit(1);
    if (!rows.length)
      return noStore({ error: 'RPM run not found.' }, { status: 404 });
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
