import { env } from 'cloudflare:workers';
import { and, desc, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getDb } from '@/db';
import { connectionProfiles, testRuns } from '@/db/schema';
import { validateBaseUrl } from '@/lib/server/connection';
import { noStore, serverError } from '@/lib/server/http';
import { NORMAL_QUESTIONS } from '@/lib/questions';

type StoredStatus = 'normal' | 'cached' | 'large' | 'error';

function nullableNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

function nullableText(value: unknown, max = 2_000) {
  return typeof value === 'string' ? value.slice(0, max) : null;
}

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return noStore({ error: 'Sign in to view saved runs.' }, { status: 401 });
  try {
    const runs = await getDb().select().from(testRuns)
      .where(eq(testRuns.userId, user.userId)).orderBy(desc(testRuns.createdAt)).limit(50);
    return noStore({ runs });
  } catch (error) {
    return serverError(error);
  }
}

export async function POST(request: NextRequest) {
  const user = await getChatGPTUser();
  if (!user) return noStore({ error: 'Sign in to save completed runs.' }, { status: 401 });
  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return noStore({ error: 'Invalid request body.' }, { status: 400 });
  }

  const profileId = typeof payload.profileId === 'string' && payload.profileId ? payload.profileId : null;
  let apiType = payload.apiType;
  let rawBaseUrl = typeof payload.baseUrl === 'string' ? payload.baseUrl.trim() : '';
  let profileName: string | null = null;
  if (profileId) {
    const profile = await getDb().select({
      name: connectionProfiles.name,
      apiType: connectionProfiles.apiType,
      baseUrl: connectionProfiles.baseUrl,
    }).from(connectionProfiles).where(and(
      eq(connectionProfiles.id, profileId), eq(connectionProfiles.userId, user.userId),
    )).limit(1);
    if (!profile.length) return noStore({ error: 'Saved profile not found.' }, { status: 404 });
    profileName = profile[0].name;
    apiType = profile[0].apiType;
    rawBaseUrl = profile[0].baseUrl;
  }
  if (apiType !== 'anthropic' && apiType !== 'openai') {
    return noStore({ error: 'Invalid API type.' }, { status: 400 });
  }
  const validated = validateBaseUrl(rawBaseUrl);
  if ('error' in validated) return noStore({ error: validated.error }, { status: 400 });
  const model = typeof payload.model === 'string' ? payload.model.trim() : '';
  if (!model || model.length > 120) return noStore({ error: 'Invalid model name.' }, { status: 400 });
  const incoming = Array.isArray(payload.results) ? payload.results : [];
  if (incoming.length !== NORMAL_QUESTIONS.length) {
    return noStore({ error: 'Only a complete 12-question run can be saved.' }, { status: 400 });
  }

  const results = incoming.map((item, position) => {
    const record = typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : {};
    const expected = NORMAL_QUESTIONS[position];
    const status: StoredStatus = ['normal', 'cached', 'large', 'error'].includes(String(record.status))
      ? (record.status as StoredStatus) : 'error';
    return {
      position,
      questionId: expected.id,
      category: expected.category,
      prompt: expected.prompt,
      status,
      httpStatus: nullableNumber(record.httpStatus),
      returnedModel: nullableText(record.returnedModel, 120),
      inputTokens: nullableNumber(record.inputTokens),
      cacheCreationInputTokens: nullableNumber(record.cacheCreationInputTokens),
      cacheReadInputTokens: nullableNumber(record.cacheReadInputTokens),
      totalInputTokens: nullableNumber(record.totalInputTokens),
      outputTokens: nullableNumber(record.outputTokens),
      requestId: nullableText(record.requestId, 500),
      answer: nullableText(record.answer, 20_000),
      rawResponse: nullableText(record.rawResponse, 250_000),
      error: nullableText(record.error, 2_000),
    };
  });
  const normalCount = results.filter((result) => result.status === 'normal').length;
  const cacheCount = results.filter((result) => result.status === 'cached').length;
  const largeCount = results.filter((result) => result.status === 'large').length;
  const errorCount = results.filter((result) => result.status === 'error').length;
  const verdict = largeCount ? 'large' : cacheCount ? 'cached' : errorCount ? 'incomplete' : 'normal';
  const runId = crypto.randomUUID();
  const createdAt = Date.now();

  try {
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO test_runs (id, user_id, profile_id, profile_name, api_type, base_url, model_name, verdict, normal_count, cache_count, large_count, error_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(runId, user.userId, profileId, profileName, apiType, validated.baseUrl, model, verdict,
        normalCount, cacheCount, largeCount, errorCount, createdAt),
      ...results.map((result) => env.DB.prepare(
        'INSERT INTO test_results (id, run_id, position, question_id, category, prompt, status, http_status, returned_model, input_tokens, cache_creation_input_tokens, cache_read_input_tokens, total_input_tokens, output_tokens, request_id, answer, raw_response, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(crypto.randomUUID(), runId, result.position, result.questionId, result.category, result.prompt,
        result.status, result.httpStatus, result.returnedModel, result.inputTokens,
        result.cacheCreationInputTokens, result.cacheReadInputTokens, result.totalInputTokens,
        result.outputTokens, result.requestId, result.answer, result.rawResponse, result.error)),
    ]);
    return noStore({ run: {
      id: runId, profileId, profileName, apiType, baseUrl: validated.baseUrl, modelName: model,
      verdict, normalCount, cacheCount, largeCount, errorCount, createdAt,
    } }, { status: 201 });
  } catch (error) {
    return serverError(error);
  }
}
