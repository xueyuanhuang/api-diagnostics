import type { ApiType } from './connection';

const MAX_RESPONSE_BYTES = 1_000_000;
export const ANIMATION_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
export class ProviderResponseSizeError extends Error {
  constructor(public limitBytes: number) {
    super(`Website response-size limit reached (${limitBytes === ANIMATION_MAX_RESPONSE_BYTES ? '32 MiB' : `${limitBytes.toLocaleString('en-US')} bytes`} of provider data, including streaming metadata). This is separate from the output-token limit; increasing tokens will not fix this error.`);
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

function mergeUsage(current: JsonRecord, incoming: unknown) {
  const record = asRecord(incoming);
  return record ? { ...current, ...record } : current;
}

function redactSecret(value: string, apiKey: string) {
  return apiKey ? value.split(apiKey).join('[REDACTED]') : value;
}

export async function readProviderStream(
  response: Response,
  apiType: ApiType,
  apiKey: string,
  startedAt: number,
  maxResponseBytes = MAX_RESPONSE_BYTES,
): Promise<ProviderStreamResult> {
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (contentLength > maxResponseBytes) {
    await response.body?.cancel();
    throw new ProviderResponseSizeError(maxResponseBytes);
  }

  let totalBytes = 0;
  let rawResponse = '';
  let lineBuffer = '';
  let answer = '';
  let usage: JsonRecord = {};
  let returnedModel: string | null = null;
  let finishReason: string | null = null;
  let firstVisibleAt: number | null = null;
  let sawSseData = false;

  const recordVisibleText = (text: string) => {
    if (!text) return;
    if (firstVisibleAt === null) firstVisibleAt = performance.now();
    answer += text;
  };

  const handleData = (rawData: string) => {
    if (!rawData || rawData === '[DONE]') return;
    const event = parseJson(rawData);
    if (!event) return;
    sawSseData = true;

    if (apiType === 'openai') {
      if (typeof event.model === 'string') returnedModel = event.model;
      usage = mergeUsage(usage, event.usage);
      const choices = Array.isArray(event.choices) ? event.choices : [];
      for (const choice of choices) {
        const choiceRecord = asRecord(choice);
        if (typeof choiceRecord?.finish_reason === 'string') finishReason = choiceRecord.finish_reason;
        const delta = asRecord(choiceRecord?.delta);
        recordVisibleText(textFromOpenAiContent(delta?.content));
        if (!delta && typeof choiceRecord?.text === 'string')
          recordVisibleText(choiceRecord.text);
      }
      return;
    }

    const message = asRecord(event.message);
    if (typeof message?.model === 'string') returnedModel = message.model;
    usage = mergeUsage(usage, message?.usage);
    usage = mergeUsage(usage, event.usage);

    const contentBlock = asRecord(event.content_block);
    if (
      contentBlock?.type === 'text' &&
      typeof contentBlock.text === 'string'
    ) {
      recordVisibleText(contentBlock.text);
    }
    const delta = asRecord(event.delta);
    if (typeof delta?.stop_reason === 'string') finishReason = delta.stop_reason;
    else if (typeof message?.stop_reason === 'string') finishReason = message.stop_reason;
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      recordVisibleText(delta.text);
    }
  };

  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxResponseBytes) {
        await reader.cancel();
        throw new ProviderResponseSizeError(maxResponseBytes);
      }
      const text = decoder.decode(value, { stream: true });
      rawResponse += text;
      lineBuffer += text;
      while (lineBuffer.includes('\n')) {
        const newlineIndex = lineBuffer.indexOf('\n');
        const line = lineBuffer.slice(0, newlineIndex).trim();
        lineBuffer = lineBuffer.slice(newlineIndex + 1);
        if (line.startsWith('data:')) handleData(line.slice(5).trim());
      }
    }
    const finalText = decoder.decode();
    rawResponse += finalText;
    lineBuffer += finalText;
    const finalLine = lineBuffer.trim();
    if (finalLine.startsWith('data:')) handleData(finalLine.slice(5).trim());
  }

  if (!sawSseData) {
    const parsed = parseJson(rawResponse);
    if (parsed) {
      if (typeof parsed.model === 'string') returnedModel = parsed.model;
      usage = mergeUsage(usage, parsed.usage);
      if (apiType === 'anthropic') {
        answer = textFromAnthropicContent(parsed.content);
        if (typeof parsed.stop_reason === 'string') finishReason = parsed.stop_reason;
      } else {
        const firstChoice = Array.isArray(parsed.choices)
          ? asRecord(parsed.choices[0])
          : null;
        if (typeof firstChoice?.finish_reason === 'string') finishReason = firstChoice.finish_reason;
        const message = asRecord(firstChoice?.message);
        answer = textFromOpenAiContent(message?.content);
      }
    }
  }

  const finishedAt = performance.now();
  const totalTimeMs = Math.max(0, Math.round(finishedAt - startedAt));
  const ttftMs =
    firstVisibleAt === null
      ? null
      : Math.max(0, Math.round(firstVisibleAt - startedAt));
  const generationMs =
    ttftMs === null ? null : Math.max(0, totalTimeMs - ttftMs);

  return {
    rawResponse: redactSecret(rawResponse, apiKey),
    answer: redactSecret(answer, apiKey),
    usage,
    returnedModel,
    finishReason,
    ttftMs,
    generationMs,
    totalTimeMs,
  };
}
