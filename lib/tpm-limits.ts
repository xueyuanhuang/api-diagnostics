import type { HttpExchange } from './http-exchange';

export type TpmLimitHeader = {
  scope:
    | 'tokens'
    | 'input tokens'
    | 'output tokens'
    | 'project tokens'
    | 'requests';
  header: string;
  limit: number | null;
  remaining: number | null;
  resetMs: number | null;
};

// Header presence reports a configured limit, not proof that this test reached it.
export function tpmLimitHeaders(exchange: HttpExchange): TpmLimitHeader[] {
  const headers = new Map(
    exchange.responseHeaders.map(([k, v]) => [k.toLowerCase(), v]),
  );
  const numeric = (key: string) => {
    const value = headers.get(key);
    if (!value?.trim() || !/^\d+(\.\d+)?$/.test(value.trim())) return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const baseTime = Date.parse(headers.get('date') ?? exchange.endedAt);
  const specifications: [TpmLimitHeader['scope'], string, string, string][] = [
    [
      'tokens',
      'x-ratelimit-limit-tokens',
      'x-ratelimit-remaining-tokens',
      'x-ratelimit-reset-tokens',
    ],
    [
      'project tokens',
      'x-ratelimit-limit-project-tokens',
      'x-ratelimit-remaining-project-tokens',
      'x-ratelimit-reset-project-tokens',
    ],
    [
      'requests',
      'x-ratelimit-limit-requests',
      'x-ratelimit-remaining-requests',
      'x-ratelimit-reset-requests',
    ],
    ...(['tokens', 'input-tokens', 'output-tokens', 'requests'] as const).map(
      (scope) =>
        [
          scope.replaceAll('-', ' ') as TpmLimitHeader['scope'],
          `anthropic-ratelimit-${scope}-limit`,
          `anthropic-ratelimit-${scope}-remaining`,
          `anthropic-ratelimit-${scope}-reset`,
        ] as [TpmLimitHeader['scope'], string, string, string],
    ),
  ];
  return specifications
    .filter(
      ([, limit, remaining, reset]) =>
        headers.has(limit) || headers.has(remaining) || headers.has(reset),
    )
    .map(([scope, limit, remaining, reset]) => ({
      scope,
      header: limit,
      limit: numeric(limit),
      remaining: numeric(remaining),
      resetMs: parseResetMs(headers.get(reset), baseTime),
    }));
}

export function parseResetMs(
  value: string | undefined,
  baseTime: number,
): number | null {
  if (!value?.trim()) return null;
  const text = value.trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text) * 1000;
  if (/^(?:\d+(?:\.\d+)?(?:ms|s|m|h))+$/.test(text)) {
    return [...text.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)].reduce(
      (sum, match) =>
        sum +
        Number(match[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[match[2]]!,
      0,
    );
  }
  // Only parse actual dates, not arbitrary text or bare numbers as date years.
  if (!/(GMT|T\d{2}:\d{2}:)/i.test(text) || !Number.isFinite(baseTime))
    return null;
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - baseTime) : null;
}

export function tpmCooldownMs(exchange: HttpExchange): number | null {
  const headers = new Map(
    exchange.responseHeaders.map(([k, v]) => [k.toLowerCase(), v]),
  );
  const baseTime = Date.parse(headers.get('date') ?? exchange.endedAt);
  const retry = parseResetMs(headers.get('retry-after'), baseTime);
  if (headers.has('retry-after') && (retry === null || !Number.isFinite(retry)))
    return null;
  const resets = tpmLimitHeaders(exchange)
    .filter((h) => h.scope !== 'requests')
    .map((h) => h.resetMs);
  const known = [retry, ...resets].filter(
    (v): v is number => v !== null && Number.isFinite(v),
  );
  return known.length ? Math.max(...known) : null;
}
