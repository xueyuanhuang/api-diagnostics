import { NextRequest } from 'next/server';

import { getChatGPTUser } from '@/app/chatgpt-auth';
import {
  type ApiType,
  endpointFromBaseUrl,
  validateBaseUrl,
} from '@/lib/server/connection';
import { decryptApiKey } from '@/lib/server/encryption';
import { noStore } from '@/lib/server/http';
import { getOwnedProfileConfig } from '@/lib/server/profile-config';
import { readProviderStream } from '@/lib/server/provider-stream';
import { combinedRequestSignal } from '@/lib/server/abort-signals';

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

function redactSecret(
  value: string,
  apiKey: string,
  replacement = '[REDACTED]',
) {
  return apiKey ? value.split(apiKey).join(replacement) : value;
}

function exportedRequestHeaders(
  headers: Record<string, string>,
  apiKey: string,
) {
  return JSON.stringify(
    Object.entries(headers).map(([name, value]) => [
      name,
      redactSecret(value, apiKey, '$API_KEY'),
    ]),
  );
}

function exportedResponseHeaders(headers: Headers, apiKey: string) {
  return JSON.stringify(
    [...headers.entries()].map(([name, value]) => [
      name,
      name === 'set-cookie' || name === 'set-cookie2'
        ? '[REDACTED]'
        : redactSecret(value, apiKey),
    ]),
  );
}

function asRecord(value: unknown) {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function providerErrorMessage(rawResponse: string) {
  const candidates = [
    rawResponse,
    ...rawResponse
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim()),
  ];
  for (const candidate of candidates) {
    if (!candidate || candidate === '[DONE]') continue;
    try {
      const body = asRecord(JSON.parse(candidate));
      const error = asRecord(body?.error);
      if (typeof error?.message === 'string') return error.message;
      if (typeof body?.message === 'string') return body.message;
    } catch {
      // Keep looking for a structured error in another response line.
    }
  }
  return null;
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
    let requestedApiType: ApiType | undefined;
    if (payload.apiType === undefined || payload.apiType === null) {
      requestedApiType = undefined;
    } else if (
      payload.apiType === 'anthropic' ||
      payload.apiType === 'openai'
    ) {
      requestedApiType = payload.apiType;
    } else {
      return { error: 'Choose a valid API type.', status: 400 } as const;
    }
    const config = await getOwnedProfileConfig({
      userId: user.userId,
      profileId: payload.profileId,
      apiType: requestedApiType,
      requestedModel: model,
    });
    if (!config)
      return {
        error: 'Saved profile, API type, or model not found.',
        status: 404,
      } as const;
    return {
      apiType: config.apiType,
      baseUrl: config.baseUrl,
      apiKey: await decryptApiKey(config.encryptedApiKey, config.keyIv),
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

  const requestUrl = endpointFromBaseUrl(baseUrl, apiType);
  const requestBody = JSON.stringify({
    model,
    max_tokens: 96,
    messages: [{ role: 'user', content: prompt }],
    stream: true,
    ...(apiType === 'openai'
      ? { stream_options: { include_usage: true } }
      : {}),
  });
  const requestHeaders = exportedRequestHeaders(headers, apiKey);
  const startedAt = performance.now();

  try {
    const upstream = await fetch(requestUrl, {
      method: 'POST',
      headers,
      body: requestBody,
      cache: 'no-store',
      redirect: 'manual',
      signal: combinedRequestSignal(request.signal, 45_000),
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
    const providerError = upstream.ok
      ? null
      : (providerErrorMessage(streamed.rawResponse) ??
        `The provider returned HTTP ${upstream.status}.`);

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
      requestMethod: 'POST',
      requestUrl,
      requestHeaders,
      requestBody,
      responseHeaders: exportedResponseHeaders(upstream.headers, apiKey),
      requestId:
        upstream.headers.get('x-request-id') ??
        upstream.headers.get('request-id') ??
        upstream.headers.get('anthropic-request-id'),
      answer: streamed.answer,
      rawResponse: streamed.rawResponse,
      error: providerError,
    });
  } catch (error) {
    const isTimeout =
      error instanceof Error &&
      (error.name === 'TimeoutError' || error.name === 'AbortError');
    const responseTooLarge =
      error instanceof Error && error.message === 'Response too large';
    return noStore(
      {
        error: responseTooLarge
          ? 'The provider returned a response larger than this tester allows.'
          : isTimeout
            ? 'The provider did not complete the response within the 45-second test limit.'
            : 'The tester relay could not complete the connection to the provider.',
        totalTimeMs: Math.max(0, Math.round(performance.now() - startedAt)),
        requestMethod: 'POST',
        requestUrl,
        requestHeaders,
        requestBody,
        responseHeaders: null,
        rawResponse: null,
      },
      { status: isTimeout ? 504 : 502 },
    );
  }
}
