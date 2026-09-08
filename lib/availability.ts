import type { BoundaryApiType } from './tool-boundary';

export const PROBE_INTERVAL_MS = 10 * 60 * 1000;
export const PROBE_HISTORY_SLOTS = 24;
export const PROBE_TIMEOUT_MS = 30_000;
export const PROBE_PROMPT = 'Reply with only OK.';
export const probeSlot = (now: number) =>
  Math.floor(now / PROBE_INTERVAL_MS) * PROBE_INTERVAL_MS;

export type AvailabilitySample = {
  slotStart: number;
  startedAt: number;
  finishedAt: number | null;
  status: 'checking' | 'ok' | 'failing' | 'unknown';
  httpStatus: number | null;
  latencyMs: number | null;
  returnedModel: string | null;
  requestId: string | null;
  answer: string | null;
  error: string | null;
};
export type AvailabilityTarget = {
  id: string;
  profileId: string;
  profileName: string;
  apiType: BoundaryApiType;
  modelName: string;
  baseUrl: string;
  createdAt: number;
  samples: AvailabilitySample[];
};
export type AvailabilityData = {
  targets: AvailabilityTarget[];
  scheduler: { configured: boolean; lastTickAt: number | null };
  serverTime: number;
};

export function targetHealth(target: AvailabilityTarget, now: number) {
  const latest = target.samples.at(-1);
  if (!latest) return { status: 'unknown', label: 'Awaiting first check' };
  if (now - latest.startedAt > PROBE_INTERVAL_MS * 2)
    return { status: 'unknown', label: 'Checks delayed' };
  if (latest.status === 'checking' && now - latest.startedAt > 90_000)
    return { status: 'unknown', label: 'Check interrupted' };
  return {
    status: latest.status,
    label: {
      ok: 'OK',
      failing: 'Failing',
      checking: 'Checking',
      unknown: 'Unknown',
    }[latest.status],
  };
}

export function historySlots(target: AvailabilityTarget, now: number) {
  const end = probeSlot(now);
  const samples = new Map(
    target.samples.map((sample) => [sample.slotStart, sample]),
  );
  return Array.from({ length: PROBE_HISTORY_SLOTS }, (_, index) => {
    const slotStart =
      end - (PROBE_HISTORY_SLOTS - index - 1) * PROBE_INTERVAL_MS;
    const sample = samples.get(slotStart);
    const status =
      sample?.status === 'checking' && now - sample.startedAt > 90_000
        ? 'unknown'
        : (sample?.status ?? 'unknown');
    return {
      slotStart,
      sample,
      status,
      label: sample
        ? `${new Date(sample.startedAt).toLocaleString()} · ${status}${sample.error ? ` · ${sample.error}` : ''}`
        : slotStart < probeSlot(target.createdAt)
          ? 'Not monitored yet'
          : `${new Date(slotStart).toLocaleString()} · No check recorded`,
    };
  });
}

export function availabilityRequestBody(
  apiType: BoundaryApiType,
  model: string,
) {
  return {
    model,
    ...(apiType === 'anthropic'
      ? { max_tokens: 32 }
      : { max_completion_tokens: 128 }),
    stream: false,
    messages: [{ role: 'user', content: PROBE_PROMPT }],
  };
}

export async function mapProbePool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
) {
  let cursor = 0;
  const results: R[] = [];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await fn(items[index]);
      }
    }),
  );
  return results;
}
