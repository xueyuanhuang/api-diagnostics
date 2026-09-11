import { env } from 'cloudflare:workers';
import { NextRequest } from 'next/server';
import { saveAnimation } from '@/lib/server/animation-store';
import { PELICAN_PROMPT, pelicanOutputLimit, PELICAN_TIMEOUT_MS } from '@/lib/pelican-test';

import { getChatGPTUser } from '@/app/chatgpt-auth';
import {
  endpointFromBaseUrl,
  validateOutboundUrl,
} from '@/lib/server/connection';
import { noStore } from '@/lib/server/http';
import { resolveTestConnection } from '@/lib/server/test-connection';
import { readProviderStream } from '@/lib/server/provider-stream';
import { combinedRequestSignal } from '@/lib/server/abort-signals';
import { IpMappingError, isRawIpv4 } from '@/lib/server/ip-mapping';
import { resolveHostedConnection } from '@/lib/server/hosted-ip-mapping';

type RequestPayload = {
  testKind?: unknown;
  animationId?: unknown;
  maxOutputTokens?: unknown;
  allowInsecureHttp?: unknown;
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

export async function POST(request: NextRequest) {
  let payload: RequestPayload;
  try {
    payload = (await request.json()) as RequestPayload;
  } catch {
    return noStore({ error: 'Invalid request body.' }, { status: 400 });
  }
  const isPelican = payload.testKind === 'pelican';
  const maxOutputTokens = isPelican ? pelicanOutputLimit(payload.maxOutputTokens) : 96;
  if (maxOutputTokens === null) return noStore({ error: 'Choose an output limit of 8,192, 16,384, or 32,768 tokens.' }, { status: 400 });
  const timeoutMs = isPelican ? PELICAN_TIMEOUT_MS : 45_000;
  const prompt = isPelican ? PELICAN_PROMPT : typeof payload.prompt === 'string' ? payload.prompt : '';
  if (!prompt || prompt.length > 1_000) {
    return noStore({ error: 'Enter a valid test question.' }, { status: 400 });
  }

  let connection;
  try {
    connection = await resolveTestConnection(payload);
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
  const animationSource = { connectionName: connection.profileName || 'One-time connection', keyHint: apiKey.slice(-4) };
  const outbound = validateOutboundUrl(baseUrl, payload.allowInsecureHttp);
  if ('error' in outbound)
    return noStore({ error: outbound.error }, { status: 400 });
  let resolved;
  try {
    resolved = await resolveHostedConnection(
      baseUrl,
      isRawIpv4(baseUrl) ? Boolean(await getChatGPTUser()) : false,
    );
  } catch (error) {
    return noStore(
      {
        error:
          error instanceof IpMappingError
            ? error.message
            : 'IP mapping could not be prepared.',
      },
      { status: error instanceof IpMappingError ? error.status : 503 },
    );
  }
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

  const requestUrl = endpointFromBaseUrl(resolved.actualBaseUrl, apiType);
  const requestBody = JSON.stringify({
    model,
    max_tokens: maxOutputTokens,
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
      signal: combinedRequestSignal(request.signal, timeoutMs),
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

    let savedAnimation = null;
    let saveError = null;
    if (isPelican && upstream.ok && streamed.answer) {
      const user = await getChatGPTUser();
      if (user) {
        try {
          savedAnimation = await saveAnimation(env, user.userId, {
            id: typeof payload.animationId === 'string' && /^[0-9a-f-]{36}$/i.test(payload.animationId) ? payload.animationId : crypto.randomUUID(),
            model, prompt, savedAt: new Date().toISOString(),
            result: { ...animationSource, answer: streamed.answer, finishReason: streamed.finishReason, maxOutputTokens, returnedModel: streamed.returnedModel, totalInputTokens, outputTokens, totalTimeMs: streamed.totalTimeMs },
          });
        } catch {
          saveError = 'The animation completed, but saving to your account failed. Retry saving below.';
        }
      }
    }

    return noStore({
      savedAnimation,
      ...(isPelican ? { ...animationSource, maxOutputTokens, finishReason: streamed.finishReason } : {}),
      saveError,
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
            ? `The provider did not complete the response within the ${timeoutMs / 1_000}-second test limit.`
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
