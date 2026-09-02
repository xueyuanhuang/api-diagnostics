import { and, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getDb } from '@/db';
import { connectionProfiles, profileModels } from '@/db/schema';
import {
  ApiType,
  endpointFromBaseUrl,
  validateBaseUrl,
} from '@/lib/server/connection';
import { decryptApiKey } from '@/lib/server/encryption';
import { noStore } from '@/lib/server/http';
import { readProviderStream } from '@/lib/server/provider-stream';

type RequestPayload = {
  profileId?: unknown;
  apiType?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
  model?: unknown;
  prompt?: unknown;
};

function numberField(record: Record<string, unknown>, key: string) {
  return typeof record[key] === 'number' ? record[key] : null;
}

async function resolveConnection(payload: RequestPayload) {
  const model = typeof payload.model === 'string' ? payload.model.trim() : '';
  if (!model || model.length > 120)
    return { error: 'Enter a valid model name.' } as const;

  if (typeof payload.profileId === 'string' && payload.profileId) {
    const user = await getChatGPTUser();
    if (!user)
      return {
        error: 'Sign in again to use this saved profile.',
        status: 401,
      } as const;
    const rows = await getDb()
      .select({
        apiType: connectionProfiles.apiType,
        baseUrl: connectionProfiles.baseUrl,
        encryptedApiKey: connectionProfiles.encryptedApiKey,
        keyIv: connectionProfiles.keyIv,
      })
      .from(connectionProfiles)
      .innerJoin(
        profileModels,
        eq(profileModels.profileId, connectionProfiles.id),
      )
      .where(
        and(
          eq(connectionProfiles.id, payload.profileId),
          eq(connectionProfiles.userId, user.userId),
          eq(profileModels.modelName, model),
        ),
      )
      .limit(1);
    if (!rows.length)
      return {
        error: 'Saved profile or model not found.',
        status: 404,
      } as const;
    const row = rows[0];
    return {
      apiType: row.apiType as ApiType,
      baseUrl: row.baseUrl,
      apiKey: await decryptApiKey(row.encryptedApiKey, row.keyIv),
      model,
    } as const;
  }

  const apiType = payload.apiType;
  const baseUrl =
    typeof payload.baseUrl === 'string' ? payload.baseUrl.trim() : '';
  const apiKey =
    typeof payload.apiKey === 'string' ? payload.apiKey.trim() : '';
  if (apiType !== 'anthropic' && apiType !== 'openai')
    return { error: 'Choose an API type.' } as const;
  const validated = validateBaseUrl(baseUrl);
  if ('error' in validated) return validated;
  if (apiKey.length < 8 || apiKey.length > 512)
    return { error: 'Enter a valid API key.' } as const;
  return { apiType, baseUrl: validated.baseUrl, apiKey, model } as const;
}

export async function POST(request: NextRequest) {
  let payload: RequestPayload;
  try {
    payload = (await request.json()) as RequestPayload;
  } catch {
    return noStore({ error: 'Invalid request body.' }, { status: 400 });
  }
  const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
  if (!prompt || prompt.length > 1_000) {
    return noStore({ error: 'Enter a valid test question.' }, { status: 400 });
  }

  let connection;
  try {
    connection = await resolveConnection(payload);
  } catch (error) {
    console.error(error);
    return noStore(
      { error: 'The saved connection could not be opened.' },
      { status: 500 },
    );
  }
  if ('error' in connection) {
    return noStore(
      { error: connection.error },
      { status: 'status' in connection ? connection.status : 400 },
    );
  }

  const { apiType, baseUrl, apiKey, model } = connection;
  const headers: Record<string, string> = {
    accept: 'text/event-stream',
    'content-type': 'application/json',
  };
  if (apiType === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers.authorization = `Bearer ${apiKey}`;
  }

  try {
    const startedAt = performance.now();
    const upstream = await fetch(endpointFromBaseUrl(baseUrl, apiType), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        max_tokens: 96,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
        stream: true,
        ...(apiType === 'openai'
          ? { stream_options: { include_usage: true } }
          : {}),
      }),
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(45_000),
    });

    const streamed = await readProviderStream(
      upstream,
      apiType,
      apiKey,
      startedAt,
    );
    const usage = streamed.usage;
    let inputTokens: number | null;
    let cacheCreationInputTokens: number | null;
    let cacheReadInputTokens: number | null;
    let totalInputTokens: number | null;
    let outputTokens: number | null;

    if (apiType === 'anthropic') {
      inputTokens = numberField(usage, 'input_tokens');
      cacheCreationInputTokens = numberField(
        usage,
        'cache_creation_input_tokens',
      );
      cacheReadInputTokens = numberField(usage, 'cache_read_input_tokens');
      totalInputTokens =
        inputTokens === null
          ? null
          : inputTokens +
            (cacheCreationInputTokens ?? 0) +
            (cacheReadInputTokens ?? 0);
      outputTokens = numberField(usage, 'output_tokens');
    } else {
      outputTokens = numberField(usage, 'completion_tokens');
      const promptTokens = numberField(usage, 'prompt_tokens');
      const reportedTotal = numberField(usage, 'total_tokens');
      totalInputTokens =
        promptTokens ??
        (reportedTotal !== null && outputTokens !== null
          ? Math.max(0, reportedTotal - outputTokens)
          : null);
      const details =
        typeof usage.prompt_tokens_details === 'object' &&
        usage.prompt_tokens_details !== null
          ? (usage.prompt_tokens_details as Record<string, unknown>)
          : {};
      cacheReadInputTokens = numberField(details, 'cached_tokens');
      cacheCreationInputTokens = null;
      inputTokens =
        totalInputTokens === null
          ? null
          : Math.max(0, totalInputTokens - (cacheReadInputTokens ?? 0));
    }

    const outputTokensPerSecond =
      outputTokens !== null &&
      streamed.generationMs !== null &&
      streamed.generationMs > 0
        ? Number((outputTokens / (streamed.generationMs / 1_000)).toFixed(2))
        : null;

    return noStore({
      httpStatus: upstream.status,
      returnedModel: streamed.returnedModel,
      inputTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
      totalInputTokens,
      outputTokens,
      ttftMs: streamed.ttftMs,
      generationMs: streamed.generationMs,
      totalTimeMs: streamed.totalTimeMs,
      outputTokensPerSecond,
      requestId:
        upstream.headers.get('x-request-id') ??
        upstream.headers.get('request-id') ??
        upstream.headers.get('anthropic-request-id'),
      answer: streamed.answer,
      rawResponse: streamed.rawResponse,
    });
  } catch (error) {
    return noStore(
      {
        error:
          error instanceof Error && error.message === 'Response too large'
            ? 'The provider returned a response larger than this tester allows.'
            : 'The relay could not reach the provider. Check the base URL and try again.',
      },
      { status: 502 },
    );
  }
}
