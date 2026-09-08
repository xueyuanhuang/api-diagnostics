import {
  diagnosticSummary,
  type DiagnosticRun,
  type DiagnosticRunSummary,
} from '../diagnostic-runs';
import {
  isEndpointProtocol,
  summarizeEndpointResponse,
} from '../endpoint-check';
import { summarizeBoundaryResponse } from '../tool-boundary';
import type { HttpExchange } from '../http-exchange';

export class DiagnosticError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export const DIAGNOSTIC_MAX_BYTES = 32 * 1024 * 1024;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new DiagnosticError('Invalid saved run.');
  return value as Record<string, unknown>;
}
function string(value: unknown, max = 4096): string {
  if (typeof value !== 'string' || value.length > max)
    throw new DiagnosticError('Invalid saved-run field.');
  return value;
}
function oneOf(value: unknown, values: string[]): value is string {
  return typeof value === 'string' && values.includes(value);
}
function nullable(value: unknown) {
  return value == null ? null : string(value);
}
function headers(value: unknown): [string, string][] {
  if (!Array.isArray(value) || value.length > 256)
    throw new DiagnosticError('Invalid captured headers.');
  return value.map((pair) => {
    if (!Array.isArray(pair) || pair.length !== 2)
      throw new DiagnosticError('Invalid captured header.');
    const name = string(pair[0], 256);
    const value = string(pair[1], 65536);
    const sensitive =
      /^(set-cookie2?|cookie|authorization|proxy-authorization|x-api-key|api-key|x-auth-token|x-access-token)$/i.test(
        name,
      );
    return [
      name,
      sensitive &&
      !['[REDACTED]', '$API_KEY', 'Bearer $API_KEY'].includes(value)
        ? '[REDACTED]'
        : value,
    ];
  });
}
function exchange(value: unknown): HttpExchange | null {
  if (value === null) return null;
  const e = object(value);
  if (
    e.requestMethod !== 'POST' ||
    typeof e.captureComplete !== 'boolean' ||
    typeof e.totalTimeMs !== 'number' ||
    !Number.isFinite(e.totalTimeMs) ||
    e.totalTimeMs < 0 ||
    (e.httpStatus !== null &&
      (!Number.isInteger(e.httpStatus) ||
        Number(e.httpStatus) < 100 ||
        Number(e.httpStatus) > 599))
  ) {
    throw new DiagnosticError('Invalid captured exchange.');
  }
  // Explicit allowlist: connection keys and arbitrary client fields never enter history.
  return {
    requestedModel: string(e.requestedModel),
    originalBaseUrl: string(e.originalBaseUrl),
    requestMethod: 'POST',
    requestUrl: string(e.requestUrl),
    requestHeaders: headers(e.requestHeaders),
    requestBody: string(e.requestBody, DIAGNOSTIC_MAX_BYTES),
    responseHeaders: headers(e.responseHeaders),
    httpStatus: e.httpStatus as number | null,
    requestId: nullable(e.requestId),
    rawResponse: string(e.rawResponse, DIAGNOSTIC_MAX_BYTES),
    captureComplete: e.captureComplete,
    startedAt: string(e.startedAt, 64),
    endedAt: string(e.endedAt, 64),
    totalTimeMs: e.totalTimeMs,
    error: nullable(e.error),
  };
}

export function validateDiagnosticRun(value: unknown): DiagnosticRun {
  const d = object(value);
  if (
    !oneOf(d.testKind, ['boundary', 'endpoints']) ||
    !oneOf(d.apiType, ['anthropic', 'openai']) ||
    typeof d.id !== 'string' ||
    !/^[a-f0-9-]{36}$/i.test(d.id) ||
    !Array.isArray(d.rows) ||
    ![1, 3].includes(d.rows.length) ||
    (d.testKind === 'boundary' && d.rows.length !== 3)
  ) {
    throw new DiagnosticError('Invalid diagnostic run.');
  }
  const createdAt = string(d.createdAt, 64);
  if (!Number.isFinite(Date.parse(createdAt)))
    throw new DiagnosticError('Invalid run date.');
  const base = {
    id: d.id,
    label: string(d.label, 256),
    model: string(d.model, 256),
    apiType: d.apiType as 'anthropic' | 'openai',
    baseUrl: string(d.baseUrl),
    profileId: nullable(d.profileId),
    createdAt,
  };
  if (d.testKind === 'boundary')
    return {
      ...base,
      testKind: 'boundary',
      rows: d.rows.map((value) => {
        const row = object(value);
        if (
          !oneOf(row.status, ['complete', 'error', 'stopped']) ||
          !oneOf(row.review, ['pending', 'denies', 'claims', 'unclear'])
        )
          throw new DiagnosticError(
            'Only finished or stopped probes can be saved.',
          );
        const e = exchange(row.exchange);
        const result = e
          ? {
              ...e,
              apiType: base.apiType,
              ...summarizeBoundaryResponse(e.rawResponse, base.apiType),
            }
          : null;
        const error = nullable(row.error) || e?.error || null;
        const bad =
          !result ||
          error ||
          result.issues.length ||
          !result.captureComplete ||
          result.httpStatus === null ||
          result.httpStatus < 200 ||
          result.httpStatus >= 300;
        return {
          status:
            row.status === 'stopped' ? 'stopped' : bad ? 'error' : 'complete',
          exchange: result,
          error,
          review: row.review as 'pending' | 'denies' | 'claims' | 'unclear',
        };
      }),
    };
  const seen = new Set<string>();
  return {
    ...base,
    testKind: 'endpoints',
    rows: d.rows.map((value) => {
      const row = object(value);
      if (
        !isEndpointProtocol(row.protocol) ||
        seen.has(row.protocol) ||
        row.caseId !== 'ok' ||
        row.repeat !== 1 ||
        !oneOf(row.status, ['pass', 'issue', 'stopped'])
      )
        throw new DiagnosticError('Invalid finished endpoint result.');
      seen.add(row.protocol);
      const e = exchange(row.exchange);
      const result = e
        ? {
            ...e,
            protocol: row.protocol,
            caseId: 'ok' as const,
            ...summarizeEndpointResponse(e.rawResponse, row.protocol, 'ok'),
          }
        : null;
      const error = nullable(row.error) || e?.error || null;
      const bad =
        !result ||
        error ||
        result.issues.length ||
        !result.captureComplete ||
        result.httpStatus === null ||
        result.httpStatus < 200 ||
        result.httpStatus >= 300;
      return {
        protocol: row.protocol,
        caseId: 'ok',
        repeat: 1,
        status: row.status === 'stopped' ? 'stopped' : bad ? 'issue' : 'pass',
        exchange: result,
        error,
      };
    }),
  };
}

type Stored = {
  evidence_key: string;
  revision: number;
  deleted_at: number | null;
  summary_json: string;
};
export function diagnosticStore(db: D1Database, bucket: R2Bucket) {
  const own = (userId: string, id: string) =>
    db
      .prepare(
        'SELECT evidence_key, revision, deleted_at, summary_json FROM diagnostic_runs WHERE user_id = ? AND id = ?',
      )
      .bind(userId, id)
      .first<Stored>();
  return {
    async list(userId: string): Promise<DiagnosticRunSummary[]> {
      const rows = await db
        .prepare(
          'SELECT summary_json FROM diagnostic_runs WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 100',
        )
        .bind(userId)
        .all<{ summary_json: string }>();
      return rows.results.map((row) => JSON.parse(row.summary_json));
    },
    async save(userId: string, run: DiagnosticRun, revision: number) {
      if (!Number.isSafeInteger(revision) || revision < 1)
        throw new DiagnosticError('Invalid save revision.');
      const before = await own(userId, run.id);
      if (before?.deleted_at !== null && before?.deleted_at !== undefined)
        throw new DiagnosticError('This saved run was deleted.', 410);
      if (before && before.revision > revision)
        throw new DiagnosticError('A newer revision is already saved.', 409);
      const body = JSON.stringify(run);
      if (new TextEncoder().encode(body).length > DIAGNOSTIC_MAX_BYTES)
        throw new DiagnosticError(
          'This evidence is too large to save. Download the raw JSON instead.',
          413,
        );
      const hash = [
        ...new Uint8Array(
          await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)),
        ),
      ]
        .map((n) => n.toString(16).padStart(2, '0'))
        .join('');
      const key = `diagnostic/v1/${encodeURIComponent(userId)}/${run.id}/${revision}-${hash}.json`;
      if (before?.revision === revision) {
        if (before.evidence_key !== key)
          throw new DiagnosticError(
            'This revision has different evidence.',
            409,
          );
        return JSON.parse(before.summary_json) as DiagnosticRunSummary;
      }
      const summary = diagnosticSummary(run);
      await bucket.put(key, body, {
        httpMetadata: { contentType: 'application/json' },
      });
      await db
        .prepare(`INSERT INTO diagnostic_runs (user_id, id, test_kind, summary_json, evidence_key, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, id) DO UPDATE SET summary_json = excluded.summary_json, evidence_key = excluded.evidence_key, revision = excluded.revision, updated_at = excluded.updated_at
        WHERE diagnostic_runs.deleted_at IS NULL AND diagnostic_runs.revision < excluded.revision AND diagnostic_runs.test_kind = excluded.test_kind`)
        .bind(
          userId,
          run.id,
          run.testKind,
          JSON.stringify(summary),
          key,
          revision,
          summary.createdAt,
          Date.now(),
        )
        .run();
      const after = await own(userId, run.id);
      if (!after || after.deleted_at !== null || after.evidence_key !== key) {
        await bucket.delete(key);
        throw new DiagnosticError(
          after?.deleted_at != null
            ? 'This saved run was deleted.'
            : 'A newer revision is already saved.',
          after?.deleted_at != null ? 410 : 409,
        );
      }
      if (before && before.evidence_key !== key)
        await bucket.delete(before.evidence_key).catch(() => {});
      return summary;
    },
    async get(userId: string, id: string) {
      const row = await own(userId, id);
      if (!row || row.deleted_at !== null)
        throw new DiagnosticError('Saved run not found.', 404);
      const object = await bucket.get(row.evidence_key);
      if (!object)
        throw new DiagnosticError(
          'Saved evidence is unavailable. Please try again.',
          503,
        );
      return {
        run: JSON.parse(row.summary_json) as DiagnosticRunSummary,
        document: await object.json<DiagnosticRun>(),
      };
    },
    async delete(userId: string, id: string) {
      const row = await own(userId, id);
      if (!row) throw new DiagnosticError('Saved run not found.', 404);
      // A tombstone prevents delayed auto-saves from recreating a deleted run.
      await db
        .prepare(
          'UPDATE diagnostic_runs SET deleted_at = ?, summary_json = ? WHERE user_id = ? AND id = ?',
        )
        .bind(Date.now(), '{}', userId, id)
        .run();
      // Include superseded objects from saves whose database acknowledgement was interrupted.
      let cursor: string | undefined;
      const keys: string[] = [];
      do {
        const page = await bucket.list({
          prefix: `diagnostic/v1/${encodeURIComponent(userId)}/${id}/`,
          cursor,
        });
        keys.push(...page.objects.map((item) => item.key));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      for (let index = 0; index < keys.length; index += 1000)
        await bucket.delete(keys.slice(index, index + 1000));
    },
  };
}
