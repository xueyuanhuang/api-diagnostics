import { openRouterRoute, isOpenRouter } from '@/lib/openrouter';
import { type ApiType, endpointFromBaseUrl } from '@/lib/server/connection';
import { createRpmStreamParser } from './rpm-stream';

export const RPM_MAX_RESPONSE_BYTES = 64_000;
const SENSITIVE_RESPONSE_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authenticate',
  'proxy-authorization',
  'set-cookie',
  'set-cookie2',
  'www-authenticate',
  'x-api-key',
]);

type ProviderRequest = {
  apiType: ApiType;
  baseUrl: string;
  originalBaseUrl?: string;
  apiKey: string;
  openRouterTier?: string | null;
  model: string;
  runId: string;
  stageIndex: number;
  sequence: number;
  plannedAt: number;
  timeoutMs?: number;
  stream?: boolean;
  signal?: AbortSignal;
  onUpstreamStarted?: (startedAt: number) => void | Promise<void>;
  onProviderSlotReleased?: () => void;
  dispatcher?: {
    mode: 'server-timed-shard-v1' | 'server-timed-shard-v2';
    shardIndex: number;
    shardCount: number;
    workerReceivedAt: number;
    readyAt: number;
    schedulerWokeAt: number;
  };
};

export type RpmRequestEvidence = {
  runId: string;
  stageIndex: number;
  sequence: number;
  plannedAt: number;
  edgeStartedAt: number;
  upstreamStartedAt: number | null;
  headersReceivedAt: number | null;
  firstByteAt: number | null;
  completedAt: number;
  scheduleLagMs: number;
  firstByteMs: number | null;
  ttftMs?: number | null;
  totalTimeMs: number;
  dispatcher?: ProviderRequest['dispatcher'];
  request: {
    method: 'POST';
    url: string;
    originalUrl?: string;
    headers: Array<[string, string]>;
    body: string;
    curl: string;
    clientRetries: 0;
  };
  response: {
    status: number | null;
    headers: Array<[string, string]>;
    body: string;
    bodyComplete: boolean;
    requestId: string | null;
    returnedModel: string | null;
    usage: Record<string, unknown> | null;
  };
  outcome:
    | 'success'
    | 'rate_limited'
    | 'client_error'
    | 'server_error'
    | 'timeout'
    | 'transport_error'
    | 'malformed'
    | 'missed_dispatch';
  error: string | null;
};

function redact(value: string, apiKey: string) {
  return apiKey ? value.split(apiKey).join('[REDACTED]') : value;
}

function responseHeaders(headers: Headers, apiKey: string) {
  return [...headers.entries()].map(([name, value]) => [
    redact(name, apiKey),
    SENSITIVE_RESPONSE_HEADERS.has(name.toLowerCase())
      ? '[REDACTED]'
      : redact(value, apiKey),
  ]) as Array<[string, string]>;
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function curlFor(
  url: string,
  headers: Record<string, string>,
  body: string,
  apiKey: string,
) {
  const parts = ['curl', '-X', 'POST', shellQuote(url)];
  for (const [name, value] of Object.entries(headers)) {
    parts.push(
      '-H',
      shellQuote(
        `${name}: ${redact(value, apiKey).replace('[REDACTED]', '$API_KEY')}`,
      ),
    );
  }
  parts.push('--data-raw', shellQuote(body));
  return parts.join(' ');
}

function record(value: unknown) {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function providerFields(apiType: ApiType, raw: string) {
  try {
    const body = record(JSON.parse(raw));
    if (!body) return { valid: false, model: null, usage: null };
    const model = typeof body.model === 'string' ? body.model : null;
    const usage = record(body.usage);
    if (apiType === 'anthropic') {
      const content = Array.isArray(body.content) ? body.content : [];
      return {
        valid: content.some(
          (item) =>
            record(item)?.type === 'text' &&
            typeof record(item)?.text === 'string',
        ),
        model,
        usage,
      };
    }
    const choices = Array.isArray(body.choices) ? body.choices : [];
    return {
      valid: choices.some((item) => {
        const choice = record(item);
        const message = record(choice?.message);
        return typeof message?.content === 'string';
      }),
      model,
      usage,
    };
  } catch {
    return { valid: false, model: null, usage: null };
  }
}

async function readBody(response: Response, input: ProviderRequest) {
  const parser = input.stream ? createRpmStreamParser(input.apiType) : null;
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let body = '';
  let bytes = 0;
  let firstByteAt: number | null = null;
  let complete = true;
  let error: unknown = null;
  try {
    while (reader) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (firstByteAt === null && chunk.value.byteLength)
        firstByteAt = Date.now();
      bytes += chunk.value.byteLength;
      if (bytes > RPM_MAX_RESPONSE_BYTES) {
        complete = false;
        await reader.cancel();
        break;
      }
      const text = decoder.decode(chunk.value, { stream: true });
      body += text;
      parser?.push(text);
    }
  } catch (caught) {
    error = caught;
    complete = false;
    await reader?.cancel().catch(() => {});
  } finally {
    reader?.releaseLock();
  }
  const tail = decoder.decode();
  body += tail;
  parser?.push(tail);
  parser?.end();
  return { body, complete, firstByteAt, stream: parser?.state, error };
}

export function missedDispatchEvidence(
  input: ProviderRequest,
  error: string,
): RpmRequestEvidence {
  const now = Date.now();
  const url = endpointFromBaseUrl(input.baseUrl, input.apiType).toString();
  const body = requestBody(input);
  const headers = providerHeaders(input.apiType, input.apiKey, input.baseUrl);
  return {
    runId: input.runId,
    stageIndex: input.stageIndex,
    sequence: input.sequence,
    plannedAt: input.plannedAt,
    edgeStartedAt: now,
    upstreamStartedAt: null,
    headersReceivedAt: null,
    firstByteAt: null,
    completedAt: now,
    scheduleLagMs: now - input.plannedAt,
    firstByteMs: null,
    ttftMs: null,
    totalTimeMs: 0,
    dispatcher: input.dispatcher,
    request: {
      method: 'POST',
      url,
      originalUrl: endpointFromBaseUrl(
        input.originalBaseUrl ?? input.baseUrl,
        input.apiType,
      ).toString(),
      headers: Object.entries(headers).map(([name, value]) => [
        name,
        redact(value, input.apiKey).replace('[REDACTED]', '$API_KEY'),
      ]),
      body,
      curl: curlFor(url, headers, body, input.apiKey),
      clientRetries: 0,
    },
    response: {
      status: null,
      headers: [],
      body: '',
      bodyComplete: true,
      requestId: null,
      returnedModel: null,
      usage: null,
    },
    outcome: 'missed_dispatch',
    error,
  };
}

function providerHeaders(apiType: ApiType, apiKey: string, baseUrl: string) {
  const headers: Record<string, string> = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
  };
  if (apiType === 'anthropic' && !isOpenRouter(baseUrl)) {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers.authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function requestBody(input: ProviderRequest) {
  return JSON.stringify({
    model: input.model,
    ...openRouterRoute(
      input.originalBaseUrl ?? input.baseUrl,
      input.apiType,
      input.model,
      input.openRouterTier,
    ),
    max_tokens: input.openRouterTier ? 512 : 8,
    messages: [
      {
        role: 'user',
        content: `Reply with only OK. RPM test ${input.runId.slice(0, 8)} stage ${input.stageIndex + 1} request ${input.sequence + 1}.`,
      },
    ],
    stream: input.stream ?? false,
  });
}

export async function runProviderRequest(
  input: ProviderRequest,
): Promise<RpmRequestEvidence> {
  const edgeStartedAt = Date.now();
  const url = endpointFromBaseUrl(input.baseUrl, input.apiType).toString();
  const headers = providerHeaders(input.apiType, input.apiKey, input.baseUrl);
  const body = requestBody(input);
  const exportedHeaders = Object.entries(headers).map(([name, value]) => [
    name,
    redact(value, input.apiKey).replace('[REDACTED]', '$API_KEY'),
  ]) as Array<[string, string]>;
  const upstreamStartedAt = Date.now();
  const timeoutMs = input.timeoutMs ?? 45_000;
  let dispatchStartPersistence = Promise.resolve();
  let providerSlotReleased = false;
  const releaseProviderSlot = () => {
    if (providerSlotReleased) return;
    providerSlotReleased = true;
    input.onProviderSlotReleased?.();
  };

  try {
    const responsePromise = fetch(url, {
      method: 'POST',
      headers,
      body,
      redirect: 'manual',
      cache: 'no-store',
      signal: input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
    });
    dispatchStartPersistence = Promise.resolve(
      input.onUpstreamStarted?.(upstreamStartedAt),
    ).catch(() => {
      // The returned response evidence still proves this attempt if its
      // separate dispatch-start marker could not be persisted.
    });
    const response = await responsePromise;
    const headersReceivedAt = Date.now();
    releaseProviderSlot();
    const read = await readBody(response, input);
    const completedAt = Date.now();
    const redactedBody = redact(read.body, input.apiKey);
    const streamed = read.stream?.sawData ? read.stream : null;
    const fields = streamed
      ? {
          valid: streamed.hasText && streamed.finished && !streamed.error,
          model: streamed.model,
          usage: streamed.usage,
        }
      : providerFields(input.apiType, redactedBody);
    const streamStatus = streamed?.errorStatus;
    const readTimedOut =
      read.error instanceof Error &&
      ['TimeoutError', 'AbortError'].includes(read.error.name);
    let outcome: RpmRequestEvidence['outcome'];
    if (response.status === 429) outcome = 'rate_limited';
    else if (response.status >= 500) outcome = 'server_error';
    else if (response.status >= 400) outcome = 'client_error';
    else if (!response.ok) outcome = 'client_error';
    else if (read.error) outcome = readTimedOut ? 'timeout' : 'transport_error';
    else if (streamStatus === 429) outcome = 'rate_limited';
    else if (streamStatus && streamStatus >= 500) outcome = 'server_error';
    else if (streamStatus && streamStatus >= 400) outcome = 'client_error';
    else if (!read.complete || !fields.valid) outcome = 'malformed';
    else outcome = 'success';
    const evidence: RpmRequestEvidence = {
      runId: input.runId,
      stageIndex: input.stageIndex,
      sequence: input.sequence,
      plannedAt: input.plannedAt,
      edgeStartedAt,
      upstreamStartedAt,
      headersReceivedAt,
      firstByteAt: read.firstByteAt,
      completedAt,
      scheduleLagMs: upstreamStartedAt - input.plannedAt,
      firstByteMs:
        read.firstByteAt === null ? null : read.firstByteAt - upstreamStartedAt,
      ttftMs:
        streamed?.firstTextAt == null
          ? null
          : Math.max(0, streamed.firstTextAt - upstreamStartedAt),
      totalTimeMs: completedAt - upstreamStartedAt,
      dispatcher: input.dispatcher,
      request: {
        method: 'POST',
        url,
        originalUrl: endpointFromBaseUrl(
          input.originalBaseUrl ?? input.baseUrl,
          input.apiType,
        ).toString(),
        headers: exportedHeaders,
        body,
        curl: curlFor(url, headers, body, input.apiKey),
        clientRetries: 0,
      },
      response: {
        status: response.status,
        headers: responseHeaders(response.headers, input.apiKey),
        body: redactedBody,
        bodyComplete: read.complete,
        requestId: (() => {
          const value =
            response.headers.get('x-request-id') ??
            response.headers.get('request-id') ??
            response.headers.get('anthropic-request-id');
          return value === null ? null : redact(value, input.apiKey);
        })(),
        returnedModel: fields.model ? redact(fields.model, input.apiKey) : null,
        usage: fields.usage
          ? JSON.parse(redact(JSON.stringify(fields.usage), input.apiKey))
          : null,
      },
      outcome,
      error:
        outcome === 'success'
          ? null
          : read.error
            ? readTimedOut
              ? `Provider request timed out after ${timeoutMs / 1_000} seconds.`
              : 'Provider stream was interrupted before completion.'
            : streamed?.error
              ? redact(streamed.error, input.apiKey)
              : !read.complete
                ? `Response exceeded ${RPM_MAX_RESPONSE_BYTES} bytes and was truncated.`
                : response.ok
                  ? streamed && !streamed.finished
                    ? 'Provider stream ended before completion was confirmed.'
                    : 'The response did not match the selected API format.'
                  : `Provider returned HTTP ${response.status}.`,
    };
    await dispatchStartPersistence;
    return evidence;
  } catch (error) {
    releaseProviderSlot();
    const completedAt = Date.now();
    const timeout =
      error instanceof Error &&
      (error.name === 'TimeoutError' || error.name === 'AbortError');
    const evidence: RpmRequestEvidence = {
      runId: input.runId,
      stageIndex: input.stageIndex,
      sequence: input.sequence,
      plannedAt: input.plannedAt,
      edgeStartedAt,
      upstreamStartedAt,
      headersReceivedAt: null,
      firstByteAt: null,
      completedAt,
      scheduleLagMs: upstreamStartedAt - input.plannedAt,
      firstByteMs: null,
      ttftMs: null,
      totalTimeMs: completedAt - upstreamStartedAt,
      dispatcher: input.dispatcher,
      request: {
        method: 'POST',
        url,
        originalUrl: endpointFromBaseUrl(
          input.originalBaseUrl ?? input.baseUrl,
          input.apiType,
        ).toString(),
        headers: exportedHeaders,
        body,
        curl: curlFor(url, headers, body, input.apiKey),
        clientRetries: 0,
      },
      response: {
        status: null,
        headers: [],
        body: '',
        bodyComplete: true,
        requestId: null,
        returnedModel: null,
        usage: null,
      },
      outcome: timeout ? 'timeout' : 'transport_error',
      error: timeout
        ? `Provider request timed out after ${timeoutMs / 1_000} seconds.`
        : error instanceof Error
          ? redact(error.message, input.apiKey)
          : 'Provider request failed.',
    };
    await dispatchStartPersistence;
    return evidence;
  }
}
