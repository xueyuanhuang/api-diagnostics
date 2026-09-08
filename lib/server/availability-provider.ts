import {
  availabilityRequestBody,
  PROBE_TIMEOUT_MS,
  type AvailabilitySample,
} from '../availability';
import type { ApiType } from './connection';
import { endpointFromBaseUrl } from './connection';
import { redactBoundarySecret } from './tool-boundary';

export type ProbeOutcome = Omit<AvailabilitySample, 'slotStart' | 'startedAt'>;
export async function checkProviderAvailability(
  connection: {
    apiType: ApiType;
    model: string;
    apiKey: string;
    actualBaseUrl: string;
  },
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<ProbeOutcome> {
  const started = performance.now();
  const result: ProbeOutcome = {
    status: 'failing',
    finishedAt: null,
    httpStatus: null,
    latencyMs: null,
    returnedModel: null,
    requestId: null,
    answer: null,
    error: null,
  };
  const deadline = AbortSignal.any([
    signal,
    AbortSignal.timeout(PROBE_TIMEOUT_MS),
  ]);
  const redact = (value: string) =>
    redactBoundarySecret(value, connection.apiKey);
  try {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
    };
    if (connection.apiType === 'anthropic') {
      headers['x-api-key'] = connection.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else headers.authorization = `Bearer ${connection.apiKey}`;
    const response = await request(
      endpointFromBaseUrl(connection.actualBaseUrl, connection.apiType),
      {
        method: 'POST',
        headers,
        body: JSON.stringify(
          availabilityRequestBody(connection.apiType, connection.model),
        ),
        redirect: 'manual',
        signal: deadline,
        cache: 'no-store',
      },
    );
    result.httpStatus = response.status;
    result.requestId =
      redact(
        response.headers.get('x-request-id') ??
          response.headers.get('request-id') ??
          '',
      ).slice(0, 200) || null;
    const reader = response.body?.getReader();
    let raw = '';
    let bytes = 0;
    const decoder = new TextDecoder();
    if (reader)
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 256 * 1024) {
            await reader.cancel();
            throw new Error('oversized');
          }
          raw += decoder.decode(part.value, { stream: true });
        }
        raw += decoder.decode();
      } finally {
        reader.releaseLock();
      }
    let body;
    try {
      body = JSON.parse(redact(raw));
    } catch {
      result.error = `${response.ok ? 'Invalid JSON response' : `HTTP ${response.status}`}.`;
      return result;
    }
    if (!response.ok || body?.error) {
      result.error = `HTTP ${response.status}${typeof body?.error?.message === 'string' ? `: ${body.error.message.slice(0, 400)}` : ': provider request failed.'}`;
      return result;
    }
    const message = body?.choices?.[0]?.message;
    const answer =
      connection.apiType === 'anthropic' && Array.isArray(body?.content)
        ? body.content
            .filter(
              (x: Record<string, unknown>) =>
                x?.type === 'text' && typeof x.text === 'string',
            )
            .map((x: { text: string }) => x.text)
            .join('\n')
        : typeof message?.content === 'string'
          ? message.content
          : '';
    const finish =
      connection.apiType === 'anthropic'
        ? body?.stop_reason
        : body?.choices?.[0]?.finish_reason;
    result.returnedModel =
      typeof body?.model === 'string' ? body.model.slice(0, 200) : null;
    result.answer = answer.slice(0, 500) || null;
    if (!answer.trim() || message?.refusal) {
      result.error = 'No usable answer returned.';
      return result;
    }
    if (!['stop', 'end_turn'].includes(finish)) {
      result.error = `Incomplete response (${typeof finish === 'string' ? finish.slice(0, 80) : 'missing finish reason'}).`;
      return result;
    }
    result.status = 'ok';
  } catch {
    result.error = signal.aborted
      ? 'Check interrupted.'
      : deadline.aborted
        ? 'Timed out after 30 seconds.'
        : 'Connection failed or response exceeded the capture limit.';
    if (signal.aborted) result.status = 'unknown';
  } finally {
    result.finishedAt = Date.now();
    result.latencyMs = Math.round(performance.now() - started);
  }
  return result;
}
