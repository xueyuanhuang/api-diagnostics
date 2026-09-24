import type { ApiType } from './connection';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | null =>
  value !== null && typeof value === 'object' ? (value as RecordValue) : null;

// Parse event boundaries, not network chunks: metadata/keepalives are not tokens.
export function createRpmStreamParser(apiType: ApiType) {
  let buffer = '',
    data: string[] = [],
    eventName = '';
  const state = {
    sawData: false,
    firstTextAt: null as number | null,
    hasText: false,
    finished: false,
    model: null as string | null,
    usage: null as RecordValue | null,
    error: null as string | null,
    errorStatus: null as number | null,
  };
  function text(value: unknown) {
    const content =
      typeof value === 'string'
        ? value
        : Array.isArray(value)
          ? value
              .map((part) => {
                const item = record(part);
                return item?.type === 'text' && typeof item.text === 'string'
                  ? item.text
                  : '';
              })
              .join('')
          : '';
    if (!content) return;
    state.hasText = true;
    state.firstTextAt ??= Date.now();
  }
  function dispatch() {
    const raw = data.join('\n');
    data = [];
    const name = eventName;
    eventName = '';
    if (!raw) return;
    state.sawData = true;
    if (raw.trim() === '[DONE]') {
      if (apiType === 'openai') state.finished = true;
      return;
    }
    let event: RecordValue | null;
    try {
      event = record(JSON.parse(raw));
    } catch {
      state.error = 'Provider sent an invalid streaming event.';
      return;
    }
    if (!event) {
      state.error = 'Provider sent an invalid streaming event.';
      return;
    }
    if (event.error || event.type === 'error' || name === 'error') {
      const error = record(event.error) ?? event;
      const status = Number(error.status ?? error.code ?? event.status);
      state.errorStatus =
        Number.isInteger(status) && status >= 400 && status <= 599
          ? status
          : error.type === 'rate_limit_error'
            ? 429
            : null;
      state.error =
        typeof error.message === 'string'
          ? error.message
          : 'Provider reported a streaming error.';
      return;
    }
    if (apiType === 'openai') {
      if (typeof event.model === 'string') state.model = event.model;
      if (record(event.usage))
        state.usage = { ...state.usage, ...record(event.usage) };
      const first = Array.isArray(event.choices)
        ? record(event.choices[0])
        : null;
      text(record(first?.delta)?.content);
      if (typeof first?.finish_reason === 'string') state.finished = true;
    } else {
      const message = record(event.message);
      if (typeof message?.model === 'string') state.model = message.model;
      if (record(message?.usage))
        state.usage = { ...state.usage, ...record(message?.usage) };
      if (record(event.usage))
        state.usage = { ...state.usage, ...record(event.usage) };
      const block = record(event.content_block),
        delta = record(event.delta);
      if (block?.type === 'text') text(block.text);
      if (delta?.type === 'text_delta') text(delta.text);
      if (event.type === 'message_stop') state.finished = true;
    }
  }
  function line(value: string) {
    if (!value) {
      dispatch();
      return;
    }
    if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
    if (value.startsWith('event:')) eventName = value.slice(6).trim();
  }
  return {
    state,
    push(value: string) {
      buffer += value;
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        line(buffer.slice(0, end).replace(/\r$/, ''));
        buffer = buffer.slice(end + 1);
      }
    },
    end() {
      if (buffer) line(buffer.replace(/\r$/, ''));
      buffer = '';
      dispatch();
    },
  };
}
