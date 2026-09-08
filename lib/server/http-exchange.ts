import { combinedRequestSignal } from './abort-signals';
import type { HttpExchange } from '../http-exchange';

export const HTTP_CAPTURE_LIMIT = 2 * 1024 * 1024;
export function redactExchangeSecret(value: string, key: string) {
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

export async function captureHttpExchange(
  connection: {
    model: string;
    apiKey: string;
    baseUrl: string;
    requestUrl: string;
    headers: Record<string, string>;
    body: string;
    timeoutMs: number;
  },
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<HttpExchange> {
  const { model, apiKey, headers, body } = connection;
  const url = connection.requestUrl;
  const redact = (value: string) => redactExchangeSecret(value, apiKey);
  const started = performance.now();
  const exchange: HttpExchange = {
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
  };
  const deadline = combinedRequestSignal(signal, connection.timeoutMs);
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
          const available = HTTP_CAPTURE_LIMIT - bytes;
          exchange.rawResponse += decoder.decode(
            part.value.subarray(0, available),
            { stream: true },
          );
          bytes += part.value.byteLength;
          if (bytes > HTTP_CAPTURE_LIMIT) {
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
        ? `Provider timed out after ${connection.timeoutMs / 1000} seconds; captured response may be partial.`
        : 'Provider request failed; captured response may be partial.';
  }
  exchange.rawResponse = redact(exchange.rawResponse);
  exchange.endedAt = new Date().toISOString();
  exchange.totalTimeMs = Math.round(performance.now() - started);
  return exchange;
}
