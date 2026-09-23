import { env } from 'cloudflare:workers';
import { and, eq, asc } from 'drizzle-orm';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getDb } from '@/db';
import { testRuns, testResults } from '@/db/schema';
import { noStore } from '@/lib/server/http';
import {
  assessResult,
  compareBaseline,
  ANALYSIS_VERSION,
} from '@/lib/result-assessment';
type Context = { params: Promise<{ id: string }> };
async function owned(userId: string, id: string) {
  const db = getDb();
  const [run] = await db
    .select()
    .from(testRuns)
    .where(and(eq(testRuns.id, id), eq(testRuns.userId, userId)))
    .limit(1);
  if (!run) return null;
  const results = await db
    .select()
    .from(testResults)
    .where(eq(testResults.runId, id))
    .orderBy(asc(testResults.position));
  return { run, results };
}
export async function GET(_request: Request, context: Context) {
  const user = await getChatGPTUser();
  if (!user) return noStore({ error: 'Sign in required.' }, { status: 401 });
  const { id } = await context.params;
  if (!(await owned(user.userId, id)))
    return noStore({ error: 'Run not found.' }, { status: 404 });
  const data = await env.DB.prepare(
    'SELECT id, report_json, created_at FROM run_assessments WHERE user_id = ? AND run_id = ? ORDER BY created_at DESC LIMIT 20',
  )
    .bind(user.userId, id)
    .all<{ id: string; report_json: string; created_at: number }>();
  return noStore({
    assessments: data.results.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      report: JSON.parse(r.report_json),
    })),
  });
}
export async function POST(request: Request, context: Context) {
  const user = await getChatGPTUser();
  if (!user) return noStore({ error: 'Sign in required.' }, { status: 401 });
  if (
    request.headers.get('origin') !== new URL(request.url).origin ||
    !request.headers.get('content-type')?.includes('application/json')
  )
    return noStore(
      { error: 'Same-origin JSON request required.' },
      { status: 403 },
    );
  let body: { referenceRunId?: string };
  try {
    body = await request.json();
  } catch {
    return noStore({ error: 'Invalid request.' }, { status: 400 });
  }
  if (
    !body ||
    typeof body !== 'object' ||
    (body.referenceRunId != null &&
      (typeof body.referenceRunId !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,100}$/.test(body.referenceRunId)))
  )
    return noStore({ error: 'Invalid reference.' }, { status: 400 });
  const { id } = await context.params;
  const current = await owned(user.userId, id);
  if (!current) return noStore({ error: 'Run not found.' }, { status: 404 });
  const reference = body.referenceRunId
    ? await owned(user.userId, body.referenceRunId)
    : null;
  if (body.referenceRunId && (!reference || body.referenceRunId === id))
    return noStore(
      { error: 'Choose a different saved run you own.' },
      { status: 400 },
    );
  const report = {
    analysisVersion: ANALYSIS_VERSION,
    createdAt: new Date().toISOString(),
    runId: id,
    referenceRunId: reference?.run.id ?? null,
    referenceModel: reference?.run.modelName ?? null,
    referenceCreatedAt: reference?.run.createdAt ?? null,
    provenance: 'User-saved evidence; not independent provider verification',
    results: current.results.map((r) => ({
      questionId: r.questionId,
      prompt: r.prompt,
      ...assessResult(r),
    })),
    comparison: reference
      ? compareBaseline(
          current.results,
          reference.results,
          current.run.apiType === reference.run.apiType,
        )
      : null,
  };
  const assessmentId = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO run_assessments (id,user_id,run_id,reference_run_id,analysis_version,report_json,created_at) VALUES (?,?,?,?,?,?,?)',
  )
    .bind(
      assessmentId,
      user.userId,
      id,
      reference?.run.id ?? null,
      ANALYSIS_VERSION,
      JSON.stringify(report),
      Date.now(),
    )
    .run();
  return noStore({ id: assessmentId, report });
}
