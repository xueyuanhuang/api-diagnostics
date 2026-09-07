import { env } from 'cloudflare:workers';
import { desc, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getDb } from '@/db';
import { testRuns } from '@/db/schema';
import { validateBaseUrl } from '@/lib/server/connection';
import { noStore, serverError } from '@/lib/server/http';
import { getOwnedProfileConfig } from '@/lib/server/profile-config';
import { NORMAL_QUESTIONS } from '@/lib/questions';

type StoredStatus = 'normal' | 'cached' | 'large' | 'unavailable' | 'error';

function nullableNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.trunc(value)
    : null;
}

function nullableFloat(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function median(values: Array<number | null>, decimals = 0) {
  const sorted = values
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
  return Number(value.toFixed(decimals));
}

function nullableText(value: unknown, max = 2_000) {
  return typeof value === 'string' ? value.slice(0, max) : null;
}

export async function GET() {
  const user = await getChatGPTUser();
  if (!user)
    return noStore({ error: 'Sign in to view saved runs.' }, { status: 401 });
  try {
    const runs = await getDb()
      .select()
      .from(testRuns)
      .where(eq(testRuns.userId, user.userId))
      .orderBy(desc(testRuns.createdAt))
      .limit(50);
    return noStore({ runs });
  } catch (error) {
    return serverError(error);
  }
}

export async function POST(request: NextRequest) {
  const user = await getChatGPTUser();
  if (!user)
    return noStore(
      { error: 'Sign in to save completed runs.' },
      { status: 401 },
    );
  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return noStore({ error: 'Invalid request body.' }, { status: 400 });
  }

  const profileId =
    typeof payload.profileId === 'string' && payload.profileId
      ? payload.profileId
      : null;
  const model = typeof payload.model === 'string' ? payload.model.trim() : '';
  if (!model || model.length > 120)
    return noStore({ error: 'Invalid model name.' }, { status: 400 });
  let apiType = payload.apiType;
  let rawBaseUrl =
    typeof payload.baseUrl === 'string' ? payload.baseUrl.trim() : '';
  if (
    payload.profileName != null &&
    (typeof payload.profileName !== 'string' ||
      payload.profileName.trim().length > 80)
  )
    return noStore(
      { error: 'Invalid history name (maximum 80 characters).' },
      { status: 400 },
    );
  // A label is not a saved credential profile. Only profileId grants that association.
  let profileName: string | null =
    typeof payload.profileName === 'string'
      ? payload.profileName.trim() || null
      : null;
  if (profileId) {
    if (
      apiType !== undefined &&
      apiType !== null &&
      apiType !== 'anthropic' &&
      apiType !== 'openai'
    ) {
      return noStore({ error: 'Invalid API type.' }, { status: 400 });
    }
    const requestedApiType =
      apiType === 'anthropic' || apiType === 'openai' ? apiType : undefined;
    const config = await getOwnedProfileConfig({
      userId: user.userId,
      profileId,
      apiType: requestedApiType,
      requestedModel: model,
      allowModelOverride: true,
    });
    if (!config)
      return noStore(
        { error: 'Saved profile, API type, or model not found.' },
        { status: 404 },
      );
    profileName = config.profileName;
    apiType = config.apiType;
    rawBaseUrl = config.baseUrl;
  }
  if (apiType !== 'anthropic' && apiType !== 'openai') {
    return noStore({ error: 'Invalid API type.' }, { status: 400 });
  }
  const validated = validateBaseUrl(rawBaseUrl);
  if ('error' in validated)
    return noStore({ error: validated.error }, { status: 400 });
  const incoming = Array.isArray(payload.results) ? payload.results : [];
  if (incoming.length !== NORMAL_QUESTIONS.length) {
    return noStore(
      { error: 'Only a complete 12-question run can be saved.' },
      { status: 400 },
    );
  }

  const results = incoming.map((item, position) => {
    const record =
      typeof item === 'object' && item !== null
        ? (item as Record<string, unknown>)
        : {};
    const expected = NORMAL_QUESTIONS[position];
    const status: StoredStatus = [
      'normal',
      'cached',
      'large',
      'unavailable',
      'error',
    ].includes(String(record.status))
      ? (record.status as StoredStatus)
      : 'error';
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
      ttftMs: nullableNumber(record.ttftMs),
      generationMs: nullableNumber(record.generationMs),
      totalTimeMs: nullableNumber(record.totalTimeMs),
      outputTokensPerSecond: nullableFloat(record.outputTokensPerSecond),
      requestMethod: nullableText(record.requestMethod, 16),
      requestUrl: nullableText(record.requestUrl, 2_048),
      requestHeaders: nullableText(record.requestHeaders, 20_000),
      requestBody: nullableText(record.requestBody, 20_000),
      responseHeaders: nullableText(record.responseHeaders, 100_000),
      requestId: nullableText(record.requestId, 500),
      answer: nullableText(record.answer, 20_000),
      rawResponse: nullableText(record.rawResponse, 1_000_000),
      error: nullableText(record.error, 2_000),
    };
  });
  const normalCount = results.filter(
    (result) => result.status === 'normal',
  ).length;
  const cacheCount = results.filter(
    (result) => result.status === 'cached',
  ).length;
  const largeCount = results.filter(
    (result) => result.status === 'large',
  ).length;
  const unavailableCount = results.filter(
    (result) => result.status === 'unavailable',
  ).length;
  const errorCount = results.filter(
    (result) => result.status === 'error',
  ).length;
  const verdict = largeCount
    ? 'large'
    : cacheCount
      ? 'cached'
      : errorCount || unavailableCount
        ? 'incomplete'
        : 'normal';
  const medianTtftMs = median(results.map((result) => result.ttftMs));
  const medianGenerationMs = median(
    results.map((result) => result.generationMs),
  );
  const medianTotalTimeMs = median(results.map((result) => result.totalTimeMs));
  const medianOutputTokensPerSecond = median(
    results.map((result) => result.outputTokensPerSecond),
    2,
  );
  const runId = crypto.randomUUID();
  const createdAt = Date.now();

  try {
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO test_runs (id, user_id, profile_id, profile_name, api_type, base_url, model_name, verdict, normal_count, cache_count, large_count, error_count, unavailable_count, median_ttft_ms, median_generation_ms, median_total_time_ms, median_output_tokens_per_second, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(
        runId,
        user.userId,
        profileId,
        profileName,
        apiType,
        validated.baseUrl,
        model,
        verdict,
        normalCount,
        cacheCount,
        largeCount,
        errorCount,
        unavailableCount,
        medianTtftMs,
        medianGenerationMs,
        medianTotalTimeMs,
        medianOutputTokensPerSecond,
        createdAt,
      ),
      ...results.map((result) =>
        env.DB.prepare(
          'INSERT INTO test_results (id, run_id, position, question_id, category, prompt, status, http_status, returned_model, input_tokens, cache_creation_input_tokens, cache_read_input_tokens, total_input_tokens, output_tokens, ttft_ms, generation_ms, total_time_ms, output_tokens_per_second, request_method, request_url, request_headers, request_body, response_headers, request_id, answer, raw_response, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).bind(
          crypto.randomUUID(),
          runId,
          result.position,
          result.questionId,
          result.category,
          result.prompt,
          result.status,
          result.httpStatus,
          result.returnedModel,
          result.inputTokens,
          result.cacheCreationInputTokens,
          result.cacheReadInputTokens,
          result.totalInputTokens,
          result.outputTokens,
          result.ttftMs,
          result.generationMs,
          result.totalTimeMs,
          result.outputTokensPerSecond,
          result.requestMethod,
          result.requestUrl,
          result.requestHeaders,
          result.requestBody,
          result.responseHeaders,
          result.requestId,
          result.answer,
          result.rawResponse,
          result.error,
        ),
      ),
    ]);
    return noStore(
      {
        run: {
          id: runId,
          profileId,
          profileName,
          apiType,
          baseUrl: validated.baseUrl,
          modelName: model,
          verdict,
          normalCount,
          cacheCount,
          largeCount,
          errorCount,
          unavailableCount,
          medianTtftMs,
          medianGenerationMs,
          medianTotalTimeMs,
          medianOutputTokensPerSecond,
          createdAt,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    return serverError(error);
  }
}
