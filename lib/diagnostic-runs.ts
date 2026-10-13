import type { ToolChoiceExchange } from './tool-choice';
import { TOOL_CHOICE_PROMPT } from './tool-choice';
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
export type ToolChoiceRow = {
  stream: boolean;
  status: 'waiting' | 'running' | 'pass' | 'issue' | 'stopped';
  exchange: ToolChoiceExchange | null;
  error: string | null;
};
export type ToolChoiceRun = ConnectionSnapshot & {
  testKind: 'tool-choice';
  rows: ToolChoiceRow[];
};
export type DiagnosticRun = EndpointRun | BoundaryRun | ToolChoiceRun;
export type DiagnosticRunSummary = {
  testKind: 'boundary' | 'endpoints' | 'tool-choice';
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
  failedCount?: number;
  inconclusiveCount?: number;
};
export const DIAGNOSTIC_LABELS = {
  boundary: 'Tool Boundary Probe',
  endpoints: 'Three Endpoints',
  'tool-choice': 'Tool Choice Test',
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
    ...(run.testKind === 'tool-choice'
      ? {
          failedCount: run.rows.filter(
            (row) => row.exchange?.verdict === 'fail',
          ).length,
          inconclusiveCount: run.rows.filter(
            (row) =>
              row.status !== 'stopped' &&
              (!row.exchange || row.exchange.verdict === 'inconclusive'),
          ).length,
        }
      : {}),
    reviewedCount:
      run.testKind === 'boundary'
        ? run.rows.filter((row) => row.review !== 'pending').length
        : 0,
  };
}

export function diagnosticExport(run: DiagnosticRun) {
  return {
    format:
      run.testKind === 'tool-choice'
        ? 'tool-choice-none-v1'
        : run.testKind === 'boundary'
          ? 'tool-boundary-v1'
          : 'three-endpoints-v1',
    captureNotes:
      'Application-level HTTP evidence. API keys and sensitive headers are redacted. Other captured response text is preserved, including reasoning and signature fields. Transport-added headers are not captured. Captures above 2 MiB or interrupted by timeout are marked partial. Usage is provider-reported; review labels are manual assessments, not proof of tool access or execution.',
    stream: run.testKind === 'tool-choice' ? 'per-row' : false,
    providerTimeoutMs: 120000,
    ...(run.testKind === 'tool-choice'
      ? {
          prompt: TOOL_CHOICE_PROMPT,
          toolChoice: 'none',
          dispatch: 'serial',
          toolExecution: 'never',
          interpretation:
            'Pass means this complete response contained no tool calls. It does not prove the parameter was forwarded or that the route always complies. Fail means a structured tool-call instruction was returned, not proof of execution.',
        }
      : run.testKind === 'endpoints'
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
