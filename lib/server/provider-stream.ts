import type { ApiType } from './connection';
import { SseFramer } from '../protocols/sse-framer';
import { redactExchangeSecret } from './http-exchange';

const MAX_RESPONSE_BYTES = 1_000_000;
export const ANIMATION_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
export class ProviderResponseSizeError extends Error {
  constructor(public limitBytes: number) {
    super(
      `Website response-size limit reached (${limitBytes === ANIMATION_MAX_RESPONSE_BYTES ? '32 MiB' : `${limitBytes.toLocaleString('en-US')} bytes`} of provider data, including streaming metadata). This is separate from the output-token limit; increasing tokens will not fix this error.`,
    );
    this.name = 'ProviderResponseSizeError';
  }
}

type JsonRecord = Record<string, unknown>;

export type ProviderStreamResult = {
  rawResponse: string;
  answer: string;
  usage: JsonRecord;
  returnedModel: string | null;
  finishReason: string | null;
  ttftMs: number | null;
  generationMs: number | null;
  totalTimeMs: number;
  captureComplete: boolean;
  capturedBytes: number;
  completionStatus: string;
  protocolFindings: string[];
  error: string | null;
  firstBodyByteMs: number | null;
  firstSseEventMs: number | null;
  lastVisibleTextMs: number | null;
  textChunkCount: number;
};

function parseJson(value: string) {
  try {
    return JSON.parse(value) as JsonRecord;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null
    ? (value as JsonRecord)
    : null;
}

function textFromOpenAiContent(value: unknown) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((part) => {
      const record = asRecord(part);
      return record && typeof record.text === 'string' ? record.text : '';
    })
    .join('');
}

function textFromAnthropicContent(value: unknown) {
  if (!Array.isArray(value)) return '';
  return value
    .map((block) => {
      const record = asRecord(block);
      return record?.type === 'text' && typeof record.text === 'string'
        ? record.text
        : '';
    })
    .join('');
}

function mergeUsage(
  current: JsonRecord,
  incoming: unknown,
  finding: (message: string) => void,
) {
  const record = asRecord(incoming);
  if (record)
    for (const [key, value] of Object.entries(record)) {
      if (
        key.includes('tokens') &&
        typeof value === 'number' &&
        typeof current[key] === 'number' &&
        value < current[key]
      )
        finding(`Cumulative usage decreased: ${key}.`);
    }
  return record ? { ...current, ...record } : current;
}

function redactSecret(value: string, apiKey: string) {
  return redactExchangeSecret(value, apiKey);
}

export async function readProviderStream(
  response: Response,
  apiType: ApiType,
  apiKey: string,
  startedAt: number,
  maxResponseBytes = MAX_RESPONSE_BYTES,
  options: {
    preservePartial?: boolean;
    signal?: AbortSignal;
    deadline?: AbortSignal;
  } = {},
): Promise<ProviderStreamResult> {
  if (
    !options.preservePartial &&
    Number(response.headers.get('content-length') ?? 0) > maxResponseBytes
  ) {
    await response.body?.cancel();
    throw new ProviderResponseSizeError(maxResponseBytes);
  }
  let totalBytes = 0;
  let rawResponse = '';
  let captureComplete = false;
  let failure: string | null = null;
  let firstBodyAt: number | null = null;
  let firstEventAt: number | null = null;
  let lastVisibleAt: number | null = null;
  let textChunkCount = 0;
  let terminal = false;
  let starts = 0;
  const blocks = new Set<number>();
  const protocolFindings: string[] = [];
  const finding = (message: string) => {
    if (!protocolFindings.includes(message)) protocolFindings.push(message);
  };
  let answer = '';
  let usage: JsonRecord = {};
  let returnedModel: string | null = null;
  let finishReason: string | null = null;
  let firstVisibleAt: number | null = null;
  let sawSseData = false;

  const recordVisibleText = (text: string) => {
    if (!text) return;
    if (firstVisibleAt === null) firstVisibleAt = performance.now();
    lastVisibleAt = performance.now();
    textChunkCount++;
    answer += text;
  };

  const handleData = (rawData: string, eventName = '') => {
    sawSseData = true;
    firstEventAt ??= performance.now();
    if (terminal) finding('Data received after the terminal event.');
    if (rawData === '[DONE]') {
      terminal = true;
      return;
    }
    if (!rawData) return;
    const event = parseJson(rawData);
    if (!event) {
      finding('Malformed JSON event.');
      return;
    }
    if (event.error || event.type === 'error' || eventName === 'error') {
      const e = asRecord(event.error);
      failure = `Provider error: ${typeof e?.message === 'string' ? e.message : typeof event.error === 'string' ? event.error : 'stream reported an error'}`;
    }
    if (event.type === 'message_start' && ++starts > 1)
      finding('Duplicate message_start event.');
    if (
      event.type === 'content_block_start' &&
      typeof event.index === 'number'
    ) {
      if (blocks.has(event.index)) finding('Duplicate content block start.');
      blocks.add(event.index);
    }
    if (
      event.type === 'content_block_delta' &&
      typeof event.index === 'number' &&
      !blocks.has(event.index)
    )
      finding('Content delta without a matching block start.');
    if (
      event.type === 'content_block_stop' &&
      typeof event.index === 'number'
    ) {
      if (!blocks.delete(event.index))
        finding('Content block stop without a matching start.');
    }
    if (event.type === 'message_stop') {
      if (blocks.size) finding('Message ended with open content blocks.');
      terminal = true;
    }
    sawSseData = true;

    if (apiType === 'openai') {
      if (typeof event.model === 'string') returnedModel = event.model;
      usage = mergeUsage(usage, event.usage, finding);
      const choices = Array.isArray(event.choices) ? event.choices : [];
      for (const choice of choices) {
        const choiceRecord = asRecord(choice);
        if (typeof choiceRecord?.finish_reason === 'string')
          finishReason = choiceRecord.finish_reason;
        const delta = asRecord(choiceRecord?.delta);
        recordVisibleText(textFromOpenAiContent(delta?.content));
        if (!delta && typeof choiceRecord?.text === 'string')
          recordVisibleText(choiceRecord.text);
      }
      return;
    }

    const message = asRecord(event.message);
    if (typeof message?.model === 'string') returnedModel = message.model;
    usage = mergeUsage(usage, message?.usage, finding);
    usage = mergeUsage(usage, event.usage, finding);

    const contentBlock = asRecord(event.content_block);
    if (
      contentBlock?.type === 'text' &&
      typeof contentBlock.text === 'string'
    ) {
      recordVisibleText(contentBlock.text);
    }
    const delta = asRecord(event.delta);
    if (typeof delta?.stop_reason === 'string')
      finishReason = delta.stop_reason;
    else if (typeof message?.stop_reason === 'string')
      finishReason = message.stop_reason;
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      recordVisibleText(delta.text);
    }
  };

  const framer = new SseFramer(handleData);
  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          captureComplete = true;
          break;
        }
        firstBodyAt ??= performance.now();
        const available = Math.max(0, maxResponseBytes - totalBytes);
        const accepted = value.subarray(0, available);
        totalBytes += accepted.byteLength;
        const text = decoder.decode(accepted, { stream: true });
        rawResponse += text;
        framer.push(text);
        if (value.byteLength > available) {
          await reader.cancel();
          throw new ProviderResponseSizeError(maxResponseBytes);
        }
      }
    } catch (error) {
      if (!options.preservePartial) throw error;
      failure = options.signal?.aborted
        ? 'Request cancelled by you; partial evidence retained.'
        : options.deadline?.aborted
          ? 'Provider request timed out; partial evidence retained.'
          : error instanceof ProviderResponseSizeError
            ? error.message
            : 'Connection interrupted; partial evidence retained.';
    } finally {
      const tail = decoder.decode();
      rawResponse += tail;
      framer.push(tail);
      reader.releaseLock();
    }
    if (framer.end() && sawSseData)
      finding('Unterminated SSE event at end of response.');
  } else captureComplete = true;

  if (!sawSseData) {
    const parsed = parseJson(rawResponse);
    if (parsed) {
      if (parsed.error) {
        const e = asRecord(parsed.error);
        failure = `Provider error: ${typeof e?.message === 'string' ? e.message : String(parsed.error)}`;
      }
      if (typeof parsed.model === 'string') returnedModel = parsed.model;
      usage = mergeUsage(usage, parsed.usage, finding);
      if (apiType === 'anthropic') {
        answer = textFromAnthropicContent(parsed.content);
        if (typeof parsed.stop_reason === 'string')
          finishReason = parsed.stop_reason;
      } else {
        const firstChoice = Array.isArray(parsed.choices)
          ? asRecord(parsed.choices[0])
          : null;
        if (typeof firstChoice?.finish_reason === 'string')
          finishReason = firstChoice.finish_reason;
        const message = asRecord(firstChoice?.message);
        answer = textFromOpenAiContent(message?.content);
      }
    }
  }

  if (sawSseData && !terminal)
    finding('Completion not confirmed: terminal event missing.');
  const outputLimited = ['length', 'max_tokens'].includes(finishReason ?? '');
  const completionStatus = failure
    ? options.signal?.aborted
      ? 'cancelled'
      : options.deadline?.aborted
        ? 'timeout'
        : 'failed'
    : !captureComplete
      ? 'incomplete'
      : outputLimited
        ? 'output_limit'
        : (sawSseData ? terminal && !!finishReason : !!finishReason)
          ? 'completed'
          : 'incomplete';
  if (completionStatus === 'incomplete')
    failure =
      'Completion not confirmed. The provider did not send the expected completion signals.';
  const finishedAt = performance.now();
  const totalTimeMs = Math.max(0, Math.round(finishedAt - startedAt));
  const ttftMs =
    firstVisibleAt === null
      ? null
      : Math.max(0, Math.round(firstVisibleAt - startedAt));
  const generationMs =
    firstVisibleAt === null || lastVisibleAt === null || textChunkCount < 2
      ? null
      : Math.max(0, Math.round(lastVisibleAt - firstVisibleAt));

  return {
    captureComplete,
    capturedBytes: totalBytes,
    completionStatus,
    protocolFindings,
    error: failure ? redactSecret(failure, apiKey) : null,
    firstBodyByteMs:
      firstBodyAt === null ? null : Math.round(firstBodyAt - startedAt),
    firstSseEventMs:
      firstEventAt === null ? null : Math.round(firstEventAt - startedAt),
    lastVisibleTextMs:
      lastVisibleAt === null ? null : Math.round(lastVisibleAt - startedAt),
    textChunkCount,
    rawResponse: redactSecret(rawResponse, apiKey),
    answer: redactSecret(answer, apiKey),
    usage: JSON.parse(redactSecret(JSON.stringify(usage), apiKey)),
    returnedModel,
    finishReason,
    ttftMs,
    generationMs,
    totalTimeMs,
  };
}
