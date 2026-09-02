import { env } from 'cloudflare:workers';
import { and, asc, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getDb } from '@/db';
import { testResults, testRuns } from '@/db/schema';
import { noStore, serverError } from '@/lib/server/http';

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, context: Context) {
  const user = await getChatGPTUser();
  if (!user) return noStore({ error: 'Sign in to view this run.' }, { status: 401 });
  const { id } = await context.params;
  try {
    const runs = await getDb().select().from(testRuns).where(and(
      eq(testRuns.id, id), eq(testRuns.userId, user.userId),
    )).limit(1);
    if (!runs.length) return noStore({ error: 'Saved run not found.' }, { status: 404 });
    const results = await getDb().select().from(testResults)
      .where(eq(testResults.runId, id)).orderBy(asc(testResults.position));
    return noStore({ run: runs[0], results });
  } catch (error) {
    return serverError(error);
  }
}

export async function DELETE(_request: NextRequest, context: Context) {
  const user = await getChatGPTUser();
  if (!user) return noStore({ error: 'Sign in to delete this run.' }, { status: 401 });
  const { id } = await context.params;
  try {
    const result = await env.DB.prepare('DELETE FROM test_runs WHERE id = ? AND user_id = ?')
      .bind(id, user.userId).run();
    if (!result.meta.changes) return noStore({ error: 'Saved run not found.' }, { status: 404 });
    return noStore({ deleted: true });
  } catch (error) {
    return serverError(error);
  }
}
