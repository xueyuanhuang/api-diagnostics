import type { HttpExchange } from './http-exchange';
import {
  ENDPOINT_CASES,
  type EndpointSummary,
  type EndpointTask,
} from './endpoint-check';
import {
  BOUNDARY_PROMPT,
  type BoundaryExchange,
  type BoundaryReview,
} from './tool-boundary';

export type EndpointExchange = HttpExchange &
  EndpointSummary &
  Pick<EndpointTask, 'protocol' | 'caseId'>;
export type EndpointRow = EndpointTask & {
  status: 'waiting' | 'running' | 'pass' | 'issue' | 'stopped';
  exchange: EndpointExchange | null;
  error: string | null;
};
export type BoundaryRow = {
  status: 'waiting' | 'running' | 'complete' | 'error' | 'stopped';
  exchange: BoundaryExchange | null;
  error: string | null;
  review: BoundaryReview;
};
type ConnectionSnapshot = {
  id: string;
  label: string;
  model: string;
  apiType: 'anthropic' | 'openai';
  baseUrl: string;
  profileId: string | null;
  createdAt: string;
};
export type EndpointRun = ConnectionSnapshot & {
  testKind: 'endpoints';
  rows: EndpointRow[];
};
export type BoundaryRun = ConnectionSnapshot & {
  testKind: 'boundary';
  rows: BoundaryRow[];
};
export type DiagnosticRun = EndpointRun | BoundaryRun;
export type DiagnosticRunSummary = {
  testKind: 'boundary' | 'endpoints';
  id: string;
  profileId: string | null;
  profileName: string;
  apiType: 'anthropic' | 'openai';
  baseUrl: string;
  modelName: string;
  createdAt: number;
  status: 'complete' | 'issues' | 'stopped';
  totalCount: number;
  capturedCount: number;
  issueCount: number;
  reviewedCount: number;
};
export const DIAGNOSTIC_LABELS = {
  boundary: 'Tool Boundary Probe',
  endpoints: 'Three Endpoints',
} as const;

export function diagnosticFinished(run: DiagnosticRun) {
  return (
    run.rows.length > 0 &&
    run.rows.every((row) => !['waiting', 'running'].includes(row.status))
  );
}

export function diagnosticSummary(run: DiagnosticRun): DiagnosticRunSummary {
  const issueCount = run.rows.filter((row) =>
    ['error', 'issue'].includes(row.status),
  ).length;
  return {
    testKind: run.testKind,
    id: run.id,
    profileId: run.profileId,
    profileName: run.label,
    apiType: run.apiType,
    baseUrl: run.baseUrl,
    modelName: run.model,
    createdAt: Date.parse(run.createdAt),
    status: run.rows.some((row) => row.status === 'stopped')
      ? 'stopped'
      : issueCount
        ? 'issues'
        : 'complete',
    totalCount: run.rows.length,
    capturedCount: run.rows.filter((row) => row.exchange !== null).length,
    issueCount,
    reviewedCount:
      run.testKind === 'boundary'
        ? run.rows.filter((row) => row.review !== 'pending').length
        : 0,
  };
}

export function diagnosticExport(run: DiagnosticRun) {
  return {
    format:
      run.testKind === 'boundary' ? 'tool-boundary-v1' : 'three-endpoints-v1',
    captureNotes:
      'Application-level HTTP evidence. API keys and sensitive headers are redacted. Other captured response text is preserved, including reasoning and signature fields. Transport-added headers are not captured. Captures above 2 MiB or interrupted by timeout are marked partial. Usage is provider-reported; review labels are manual assessments, not proof of tool access or execution.',
    stream: false,
    providerTimeoutMs: 120000,
    ...(run.testKind === 'endpoints'
      ? {
          prompts: ENDPOINT_CASES,
          dispatch: 'concurrent',
          concurrency: run.rows.length,
        }
      : {
          prompt: BOUNDARY_PROMPT,
          repeats: 3,
          intervalAfterCompletionMs: 3000,
        }),
    ...run,
  };
}
