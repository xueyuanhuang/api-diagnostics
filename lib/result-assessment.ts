import { SseFramer } from './protocols/sse-framer';
export const ANALYSIS_VERSION = 'evidence-review-2.0';
export const COLLECTOR_VERSION = 'stream-capture-2.0';
export type EvidenceInput = {
  id?: string;
  questionId?: string;
  prompt?: string;
  answer?: string | null;
  requestBody?: string | null;
  rawResponse?: string | null;
  error?: string | null;
  httpStatus?: number | null;
  totalInputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  outputTokens?: number | null;
  assessmentJson?: string | null;
};
export function inspectRaw(raw: string | null | undefined) {
  const findings: string[] = [];
  let providerError: string | null = null;
  let events = 0,
    starts = 0,
    ended = false;
  const inspect = (text: string, name = '') => {
    if (ended) findings.push('Data after terminal event.');
    if (text === '[DONE]') {
      ended = true;
      return;
    }
    try {
      const value = JSON.parse(text);
      if (value.error || value.type === 'error' || name === 'error')
        providerError =
          typeof value.error?.message === 'string'
            ? value.error.message
            : 'Provider reported an error.';
      if (value.type === 'message_start' && ++starts > 1)
        findings.push('Duplicate message_start.');
      if (value.type === 'message_stop') ended = true;
    } catch {
      findings.push('Malformed JSON event.');
    }
  };
  if (raw?.trim().startsWith('{')) inspect(raw);
  else if (raw) {
    const framer = new SseFramer((data, event) => {
      events++;
      inspect(data, event);
    });
    framer.push(raw);
    if (framer.end() && events) findings.push('Unterminated event.');
    if (events && !ended) findings.push('Terminal event missing.');
  }
  return { providerError, findings };
}
export function assessResult(row: EvidenceInput) {
  let capture: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.assessmentJson || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) capture = parsed;
  } catch {
    /* legacy */
  }
  const issues: string[] = [];
  const raw = inspectRaw(row.rawResponse);
  const inspectUsage = (obj: unknown, path = 'usage') => {
    if (!obj || typeof obj !== 'object') return;
    for (const [key, value] of Object.entries(obj)) {
      if (
        key.includes('tokens') &&
        value != null &&
        typeof value !== 'object' &&
        (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
      )
        issues.push(`Invalid ${path}.${key}.`);
      if (typeof value === 'object') inspectUsage(value, `${path}.${key}`);
    }
  };
  inspectUsage(capture.rawUsage);
  const fields = [
    'totalInputTokens',
    'cacheReadInputTokens',
    'cacheCreationInputTokens',
    'outputTokens',
  ] as const;
  for (const field of fields) {
    const value = row[field];
    if (value != null && (!Number.isSafeInteger(value) || value < 0))
      issues.push(`Invalid ${field}: expected a non-negative safe integer.`);
  }
  if (
    row.totalInputTokens != null &&
    (row.cacheReadInputTokens ?? 0) > row.totalInputTokens
  )
    issues.push('Cache read exceeds total input.');
  const hasUsage = row.totalInputTokens != null && row.outputTokens != null;
  return {
    analysisVersion: ANALYSIS_VERSION,
    completion: raw.providerError
      ? 'failed'
      : (capture.completionStatus ?? (row.error ? 'failed' : 'unassessed')),
    providerError: raw.providerError,
    capture:
      capture.captureComplete === true
        ? 'complete'
        : capture.captureComplete === false
          ? 'partial'
          : 'unknown (legacy record)',
    usageAvailability: issues.length
      ? 'invalid'
      : hasUsage
        ? 'present'
        : row.totalInputTokens != null || row.outputTokens != null
          ? 'partial'
          : 'missing',
    inputSize:
      row.totalInputTokens == null || issues.length
        ? 'unassessed'
        : row.totalInputTokens >= 1000
          ? 'elevated: heuristic threshold, not proof of added prompts'
          : 'below heuristic threshold',
    cache:
      (row.cacheReadInputTokens ?? 0) > 0 &&
      (row.cacheCreationInputTokens ?? 0) > 0
        ? 'read and write reported'
        : (row.cacheReadInputTokens ?? 0) > 0
          ? 'read reported'
          : (row.cacheCreationInputTokens ?? 0) > 0
            ? 'write reported'
            : row.cacheReadInputTokens == null &&
                row.cacheCreationInputTokens == null
              ? 'unknown'
              : 'none reported',
    issues,
    protocolFindings: [
      ...new Set([
        ...(Array.isArray(capture.protocolFindings)
          ? capture.protocolFindings
          : []),
        ...raw.findings,
      ]),
    ],
    evidenceVersion:
      capture.collectorVersion ?? 'legacy: collector version not recorded',
  };
}
export function comparableSettings(body: string | null | undefined) {
  try {
    const parsed = JSON.parse(body || 'null');
    if (!parsed || typeof parsed !== 'object') return null;
    // Compare complete parameters, excluding model and per-question prompt only.
    const { model, messages, input, ...settings } = parsed;
    const stable = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(stable)
        : v && typeof v === 'object'
          ? Object.fromEntries(
              Object.entries(v)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, v]) => [k, stable(v)]),
            )
          : v;
    return JSON.stringify(stable(settings));
  } catch {
    return null;
  }
}
export function compareBaseline(
  current: EvidenceInput[],
  reference: EvidenceInput[],
  sameProtocol: boolean,
) {
  const pairs = current.map((row) => ({
    row,
    ref: reference.find((r) => r.prompt === row.prompt),
  }));
  const eligible = pairs.filter(
    ({ row, ref }) =>
      ref &&
      sameProtocol &&
      comparableSettings(row.requestBody) !== null &&
      comparableSettings(row.requestBody) ===
        comparableSettings(ref.requestBody) &&
      !row.error &&
      !ref.error &&
      row.answer &&
      ref.answer &&
      assessResult(row).completion === 'completed' &&
      assessResult(ref).completion === 'completed' &&
      !assessResult(row).protocolFindings.length &&
      !assessResult(ref).protocolFindings.length,
  );
  const observations = eligible.map(({ row, ref }) => {
    const a = row.answer!.trim(),
      b = ref!.answer!.trim();
    return {
      prompt: row.prompt,
      identicalText: a === b,
      currentCharacters: a.length,
      referenceCharacters: b.length,
      inputTokenDifference:
        row.totalInputTokens != null && ref!.totalInputTokens != null
          ? row.totalInputTokens - ref!.totalInputTokens
          : null,
    };
  });
  return {
    analysisVersion: ANALYSIS_VERSION,
    verdict:
      eligible.length < 6
        ? 'Insufficient comparable evidence'
        : 'Descriptive comparison available; model identity not assessed',
    coverage: `${eligible.length}/${current.length} questions comparable`,
    observations,
    limitations: [
      'Reference is a user-selected saved run, not a verified official baseline.',
      'Requires matching prompts, protocol and request parameters; only confirmed completed answers are compared.',
      'Single-run answer differences may be normal variation. No authenticity probability is calculated.',
      'Older records without completion metadata are excluded rather than assumed complete.',
    ],
  };
}
