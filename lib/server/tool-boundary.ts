import {
  boundaryRequestBody,
  BOUNDARY_TIMEOUT_MS,
  summarizeBoundaryResponse,
  type BoundaryApiType,
  type BoundaryExchange,
} from '../tool-boundary';
import { endpointFromBaseUrl } from './connection';
import { combinedRequestSignal } from './abort-signals';

export const BOUNDARY_CAPTURE_LIMIT = 2 * 1024 * 1024;
export function redactBoundarySecret(value: string, key: string) {
  if (!key) return value;
  // Inspect JSON string tokens so equivalent Unicode/slash escapes cannot reveal
  // a key when the raw response is later decoded. Unchanged tokens stay exact.
  return value
    .replace(/"(?:\\[\s\S]|[^"\\])*"/g, (token) => {
      try {
        const decoded: string = JSON.parse(token);
        return decoded.includes(key)
          ? JSON.stringify(decoded.split(key).join('[REDACTED]'))
          : token;
      } catch {
        return token;
      }
    })
    .split(key)
    .join('[REDACTED]')
    .split(JSON.stringify(key).slice(1, -1))
    .join('[REDACTED]');
}

export async function captureBoundaryExchange(
  connection: {
    apiType: BoundaryApiType;
    model: string;
    apiKey: string;
    baseUrl: string;
    actualBaseUrl: string;
  },
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<BoundaryExchange> {
  const { apiType, model, apiKey } = connection;
  const redact = (value: string) => redactBoundarySecret(value, apiKey);
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
  };
  if (apiType === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else headers.authorization = `Bearer ${apiKey}`;
  const url = endpointFromBaseUrl(connection.actualBaseUrl, apiType).href;
  const body = JSON.stringify(boundaryRequestBody(apiType, model));
  const started = performance.now();
  const exchange: BoundaryExchange = {
    apiType,
    requestedModel: redact(model),
    originalBaseUrl: redact(connection.baseUrl),
    requestMethod: 'POST',
    requestUrl: redact(url),
    requestHeaders: Object.entries(headers).map(([name, value]) => [
      name,
      name === 'authorization'
        ? 'Bearer $API_KEY'
        : name === 'x-api-key'
          ? '$API_KEY'
          : redact(value),
    ]),
    requestBody: redact(body),
    responseHeaders: [],
    httpStatus: null,
    requestId: null,
    rawResponse: '',
    captureComplete: false,
    startedAt: new Date().toISOString(),
    endedAt: '',
    totalTimeMs: 0,
    error: null,
    answer: '',
    returnedModel: null,
    finishReasons: [],
    structuredToolCalls: [],
    issues: [],
  };
  const deadline = combinedRequestSignal(signal, BOUNDARY_TIMEOUT_MS);
  try {
    const response = await request(url, {
      method: 'POST',
      headers,
      body,
      cache: 'no-store',
      redirect: 'manual',
      signal: deadline,
    });
    exchange.httpStatus = response.status;
    exchange.responseHeaders = [...response.headers.entries()].map(
      ([name, value]) => [
        name,
        /^(set-cookie2?|authorization|proxy-authorization|x-api-key)$/i.test(
          name,
        )
          ? '[REDACTED]'
          : redact(value),
      ],
    );
    exchange.requestId =
      redact(
        response.headers.get('x-request-id') ??
          response.headers.get('request-id') ??
          response.headers.get('anthropic-request-id') ??
          '',
      ) || null;
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    if (reader) {
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) {
            exchange.captureComplete = true;
            break;
          }
          const available = BOUNDARY_CAPTURE_LIMIT - bytes;
          exchange.rawResponse += decoder.decode(
            part.value.subarray(0, available),
            { stream: true },
          );
          bytes += part.value.byteLength;
          if (bytes > BOUNDARY_CAPTURE_LIMIT) {
            exchange.error =
              'Response exceeded the 2 MiB capture limit; raw data is partial.';
            await reader.cancel();
            break;
          }
        }
      } finally {
        exchange.rawResponse += decoder.decode();
        reader.releaseLock();
      }
    } else exchange.captureComplete = true;
    if (!response.ok)
      exchange.error ??= `Provider returned HTTP ${response.status}.`;
  } catch {
    exchange.error = signal.aborted
      ? 'Request cancelled; captured response may be partial.'
      : deadline.aborted
        ? 'Provider timed out after 120 seconds; captured response may be partial.'
        : 'Provider request failed; captured response may be partial.';
  }
  exchange.rawResponse = redact(exchange.rawResponse);
  exchange.endedAt = new Date().toISOString();
  exchange.totalTimeMs = Math.round(performance.now() - started);
  Object.assign(
    exchange,
    summarizeBoundaryResponse(exchange.rawResponse, apiType),
  );
  return exchange;
}
