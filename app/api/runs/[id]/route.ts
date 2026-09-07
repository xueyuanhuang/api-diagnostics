import { env } from 'cloudflare:workers';
import { and, asc, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getDb } from '@/db';
import { testResults, testRuns } from '@/db/schema';
import { noStore, serverError } from '@/lib/server/http';
import {
  assignHistoryConnection,
  HistoryAssignmentError,
} from '@/lib/server/history-assignment';

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, context: Context) {
  const user = await getChatGPTUser();
  if (!user)
    return noStore(
      { error: 'Sign in to organize saved runs.' },
      { status: 401 },
    );
  // JSON-only, same-origin UI mutation. Cross-site forms cannot send this request.
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin)
    return noStore(
      { error: 'Cross-origin changes are not allowed.' },
      { status: 403 },
    );
  if (!request.headers.get('content-type')?.includes('application/json'))
    return noStore({ error: 'Expected JSON.' }, { status: 415 });
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return noStore({ error: 'Invalid request body.' }, { status: 400 });
  }
  const profileId =
    payload &&
    typeof payload === 'object' &&
    'profileId' in payload &&
    typeof payload.profileId === 'string'
      ? payload.profileId
      : '';
  const { id } = await context.params;
  try {
    return noStore(
      await assignHistoryConnection(env.DB, user.userId, id, profileId),
    );
  } catch (error) {
    if (error instanceof HistoryAssignmentError)
      return noStore({ error: error.message }, { status: error.status });
    return serverError(error);
  }
}

export async function GET(_request: NextRequest, context: Context) {
  const user = await getChatGPTUser();
  if (!user)
    return noStore({ error: 'Sign in to view this run.' }, { status: 401 });
  const { id } = await context.params;
  try {
    const runs = await getDb()
      .select()
      .from(testRuns)
      .where(and(eq(testRuns.id, id), eq(testRuns.userId, user.userId)))
      .limit(1);
    if (!runs.length)
      return noStore({ error: 'Saved run not found.' }, { status: 404 });
    const results = await getDb()
      .select()
      .from(testResults)
      .where(eq(testResults.runId, id))
      .orderBy(asc(testResults.position));
    return noStore({ run: runs[0], results });
  } catch (error) {
    return serverError(error);
  }
}

export async function DELETE(_request: NextRequest, context: Context) {
  const user = await getChatGPTUser();
  if (!user)
    return noStore({ error: 'Sign in to delete this run.' }, { status: 401 });
  const { id } = await context.params;
  try {
    const result = await env.DB.prepare(
      'DELETE FROM test_runs WHERE id = ? AND user_id = ?',
    )
      .bind(id, user.userId)
      .run();
    if (!result.meta.changes)
      return noStore({ error: 'Saved run not found.' }, { status: 404 });
    return noStore({ deleted: true });
  } catch (error) {
    return serverError(error);
  }
}
