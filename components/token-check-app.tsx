'use client';
import { readApiResponse } from '@/lib/api-response';
import { assessResult } from '@/lib/result-assessment';
import { EvidenceReviewPanel } from './evidence-review-panel';
import { isOpenRouter, routeEvidence, type OpenRouterTier } from '@/lib/openrouter';
import { ModelPicker } from '@/components/model-picker';
import { WorkspaceLink as Link } from '@/components/workspace-navigation';
import { useWorkspaceNavigation } from '@/components/workspace-navigation';
import { confirmHttpRisk, isInsecureHttp } from '@/lib/http-consent';
import { activeConnectionId, rememberConnection } from '@/lib/saved-connections';
import { validateBaseUrl } from '@/lib/server/connection';
/* oxlint-disable react/react-compiler */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { SyntheticEvent } from 'react';
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Code2,
  Download,
  Eye,
  EyeOff,
  Gauge,
  History,
  KeyRound,
  LockKeyhole,
  LogIn,
  Play,
  Plus,
  ListChecks,
  RotateCcw,
  Save,
  ShieldCheck,
  Square,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { AvailabilityMonitor } from '@/components/availability-monitor';
import {
  DIAGNOSTIC_LABELS,
  type DiagnosticRun,
  type DiagnosticRunSummary,
} from '@/lib/diagnostic-runs';
import { EndpointCheck } from '@/components/endpoint-check';
import { ToolBoundaryTest } from '@/components/tool-boundary-test';
import { RpmRampTest } from '@/components/rpm-ramp-test';
import { NormalOutcomeCounts } from '@/components/normal-outcome-counts';
import { ModelTestQueue } from '@/components/model-test-queue';
import { AssignRunConnection } from '@/components/assign-run-connection';
import { normalOutcomes, normalOutcomeTitle } from '@/lib/normal-outcomes';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  buildInlineCurlCommand,
  downloadEvidenceArchive,
  type EvidenceRun,
} from '@/lib/evidence-export';
import { NORMAL_QUESTIONS } from '@/lib/questions';
import { NormalTestQueue, isQueueActive } from '@/lib/normal-test-queue';
import type { NormalQuestion } from '@/lib/normal-test-runner';
import type { RpmRunSummary } from '@/lib/rpm-types';

type ApiType = 'anthropic' | 'openai';
type ResultStatus =
  | 'waiting'
  | 'running'
  | 'stopped'
  | 'normal'
  | 'cached'
  | 'large'
  | 'unavailable'
  | 'error';
type ViewMode = 'current' | 'saved' | 'detail';
type ResultsView = 'tokens' | 'performance';
type TestMode = 'normal' | 'rpm' | 'boundary' | 'endpoints' | 'availability';
type NormalPhase =
  | 'idle'
  | 'queued'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'saving'
  | 'complete';

type ConnectionSettings = { baseUrl: string; model: string };
type ApiKeys = Record<ApiType, string>;
type ProfileModels = Record<ApiType, string[]>;
type DraftTouched = Record<
  ApiType,
  { baseUrl: boolean; model: boolean; apiKey: boolean; models: boolean }
>;
type User = { displayName: string; email: string } | null;
type RunContext = {
  id?: string | null;
  source: 'current' | 'saved';
  profileName?: string | null;
  apiType: ApiType;
  baseUrl: string;
  modelName: string;
  createdAt: number;
};

type ProfileConfig = {
  baseUrl: string;
  model: string;
  models: string[];
  hasSavedKey: boolean;
};

type Profile = {
  id: string;
  name: string;
  defaultApiType: ApiType;
  configs: Record<ApiType, ProfileConfig>;
  hasSavedKey: boolean;
  createdAt: number;
  updatedAt: number;
};

type RunSummary = {
  testKind: 'normal';
  id: string;
  profileId: string | null;
  profileName: string | null;
  apiType: ApiType;
  baseUrl: string;
  modelName: string;
  verdict: string;
  normalCount: number;
  cacheCount: number;
  largeCount: number;
  errorCount: number;
  unavailableCount?: number;
  medianTtftMs?: number | null;
  medianGenerationMs?: number | null;
  medianTotalTimeMs?: number | null;
  medianOutputTokensPerSecond?: number | null;
  createdAt: number;
};

type SavedRunSummary = RunSummary | RpmRunSummary | DiagnosticRunSummary;

type TestResult = {
  id: string;
  category: string;
  prompt: string;
  status: ResultStatus;
  httpStatus?: number | null;
  returnedModel?: string | null;
  inputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  totalInputTokens?: number | null;
  outputTokens?: number | null;
  ttftMs?: number | null;
  generationMs?: number | null;
  totalTimeMs?: number | null;
  outputTokensPerSecond?: number | null;
  requestMethod?: string | null;
  requestUrl?: string | null;
  requestHeaders?: string | null;
  requestBody?: string | null;
  responseHeaders?: string | null;
  requestId?: string | null;
  answer?: string | null;
  rawResponse?: string | null;
  assessmentJson?: string | null;
  completionStatus?: string;
  error?: string | null;
};

type ApiResponse = Omit<TestResult, 'id' | 'category' | 'prompt' | 'status'> & {
  error?: string;
};

const DEFAULT_CONNECTIONS: Record<ApiType, ConnectionSettings> = {
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-6',
  },
  openai: { baseUrl: 'https://api.openai.com/v1', model: '' },
};
const EMPTY_API_KEYS: ApiKeys = { anthropic: '', openai: '' };
const EMPTY_PROFILE_MODELS: ProfileModels = { anthropic: [], openai: [] };
const EMPTY_DRAFT_TOUCHED: DraftTouched = {
  anthropic: {
    baseUrl: false,
    model: false,
    apiKey: false,
    models: false,
  },
  openai: {
    baseUrl: false,
    model: false,
    apiKey: false,
    models: false,
  },
};
const SETTINGS_KEY = 'normal-token-check:connection:v4';
const V3_SETTINGS_KEY = 'normal-token-check:connection:v3';
const OLD_SETTINGS_KEY = 'normal-token-check:connection:v2';
const LEGACY_SETTINGS_KEY = 'normal-token-check:connection:v1';

function migratedDraftTouched(
  connections: Record<ApiType, ConnectionSettings>,
  activeType: ApiType,
): DraftTouched {
  function customized(type: ApiType, field: keyof ConnectionSettings) {
    return (
      Boolean(connections[type][field]) &&
      connections[type][field] !== DEFAULT_CONNECTIONS[type][field]
    );
  }

  return Object.fromEntries(
    (['anthropic', 'openai'] as const).map((type) => {
      const otherType = type === 'anthropic' ? 'openai' : 'anthropic';
      return [
        type,
        {
          ...EMPTY_DRAFT_TOUCHED[type],
          baseUrl:
            customized(type, 'baseUrl') ||
            (type === activeType && customized(otherType, 'baseUrl')),
          model:
            customized(type, 'model') ||
            (type === activeType && customized(otherType, 'model')),
        },
      ];
    }),
  ) as DraftTouched;
}

const initialResults = (): TestResult[] =>
  NORMAL_QUESTIONS.map((question) => ({ ...question, status: 'waiting' }));

function numberOrDash(value: number | null | undefined) {
  return typeof value === 'number' ? value.toLocaleString() : '—';
}

function durationOrDash(value: number | null | undefined) {
  if (typeof value !== 'number') return '—';
  return value < 1_000
    ? `${value.toLocaleString()} ms`
    : `${(value / 1_000).toFixed(3)} s`;
}

function rateOrDash(value: number | null | undefined) {
  return typeof value === 'number' ? `${value.toFixed(2)} tok/s` : '—';
}

function median(values: Array<number | null | undefined>, decimals = 0) {
  const sorted = values
    .filter((value): value is number => typeof value === 'number')
    .sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
  return Number(value.toFixed(decimals));
}

function stripEndpoint(endpoint: string, apiType: ApiType) {
  const suffix =
    apiType === 'anthropic' ? '/v1/messages' : '/v1/chat/completions';
  return endpoint.replace(/\/+$/, '').endsWith(suffix)
    ? endpoint.replace(/\/+$/, '').slice(0, -suffix.length)
    : endpoint;
}

function clientBaseUrlError(baseUrl: string) {
  const result = validateBaseUrl(baseUrl);
  return 'error' in result ? result.error : '';
}

function classifyResult(
  result: ApiResponse,
): Exclude<ResultStatus, 'waiting' | 'running' | 'stopped'> {
  if (result.error || (result.completionStatus && !['completed', 'output_limit'].includes(result.completionStatus))) return 'error';
  if (result.completionStatus === 'output_limit' || assessResult(result).usageAvailability === 'invalid' || assessResult(result).protocolFindings.length) return 'unavailable';
  if (!result.httpStatus || result.httpStatus < 200 || result.httpStatus >= 300)
    return 'error';
  if (typeof result.totalInputTokens !== 'number') return 'unavailable';
  if (result.totalInputTokens >= 1_000) return 'large';
  if (
    (result.cacheCreationInputTokens ?? 0) > 0 ||
    (result.cacheReadInputTokens ?? 0) > 0
  )
    return 'cached';
  return 'normal';
}

function verdict(status: ResultStatus) {
  if (status === 'normal')
    return {
      label: 'Normal',
      icon: CheckCircle2,
      className: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    };
  if (status === 'cached')
    return {
      label: 'Cache reported',
      icon: CheckCircle2,
      className: 'border-sky-200 bg-sky-50 text-sky-900',
    };
  if (status === 'large')
    return {
      label: 'Elevated input',
      icon: AlertTriangle,
      className: 'border-rose-200 bg-rose-50 text-rose-800',
    };
  if (status === 'unavailable')
    return {
      label: 'Needs review',
      icon: AlertTriangle,
      className: 'border-slate-200 bg-slate-50 text-slate-700',
    };
  if (status === 'error')
    return {
      label: 'Failed',
      icon: XCircle,
      className: 'border-rose-200 bg-rose-50 text-rose-800',
    };
  if (status === 'stopped')
    return {
      label: 'Stopped',
      icon: Square,
      className: 'border-slate-200 bg-slate-50 text-slate-700',
    };
  return {
    label: status === 'running' ? 'Testing' : 'Waiting',
    icon: Activity,
    className: 'border-slate-200 bg-slate-50 text-slate-600',
  };
}

function savedRpmVerdict(run: RpmRunSummary) {
  if (run.status === 'passed')
    return {
      label: `Passed ${run.targetRpm.toLocaleString()} RPM`,
      className: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    };
  if (run.status === 'failed')
    return {
      label: `Stopped at ${(run.stoppedAtRpm ?? 0).toLocaleString()} RPM`,
      className: 'border-rose-200 bg-rose-50 text-rose-800',
    };
  if (run.status === 'inconclusive')
    return {
      label: 'Inconclusive',
      className: 'border-amber-200 bg-amber-50 text-amber-900',
    };
  return {
    label: run.status === 'cancelled' ? 'Cancelled' : 'In progress',
    className: 'border-slate-200 bg-slate-50 text-slate-700',
  };
}

function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  return fetch(url, { cache: 'no-store', ...init }).then(async (response) => {
    const data = (await response.json()) as T & { error?: string };
    if (!response.ok || data.error)
      throw new Error(
        data.error || `Request failed with status ${response.status}.`,
      );
    return data;
  });
}

async function testFetch(init: RequestInit): Promise<ApiResponse> {
  const response = await fetch('/api/test', { cache: 'no-store', ...init });
  const data = await readApiResponse<ApiResponse>(response, { preserveEvidence: true });
  if (!response.ok && !data.requestBody) {
    throw new Error(
      data.error || `Request failed with status ${response.status}.`,
    );
  }
  return data;
}

function formattedJson(value: string | null | undefined) {
  if (!value) return null;
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function errorFromRawResponse(value: string | null | undefined) {
  if (!value) return null;
  const candidates = [
    value,
    ...value
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim()),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as {
        message?: unknown;
        error?: { message?: unknown };
      };
      if (typeof parsed.error?.message === 'string')
        return parsed.error.message;
      if (typeof parsed.message === 'string') return parsed.message;
    } catch {
      // Older records can contain SSE or non-JSON provider responses.
    }
  }
  return null;
}

function resultErrorMessage(result: TestResult) {
  return result.error || errorFromRawResponse(result.rawResponse);
}

function errorSolution(result: TestResult, message: string | null) {
  if (result.status !== 'error') return null;
  const detail = `${message ?? ''} ${result.rawResponse ?? ''}`.toLowerCase();
  const preparationError = (message ?? '').toLowerCase();
  if (
    !result.requestUrl &&
    !result.requestBody &&
    !result.httpStatus &&
    (preparationError.includes('dns mapping') ||
      preparationError.includes('dns resolver') ||
      preparationError.includes('automatic ip mapping'))
  ) {
    return 'The tester could not prepare the IP-to-hostname mapping, so no provider request was sent. Contact the site owner to check the DNS mapping service; changing the model or provider API key will not fix this step.';
  }
  if (
    detail.includes('temperature') ||
    detail.includes('top_p') ||
    detail.includes('top_k')
  ) {
    return 'Remove temperature, top_p, and top_k. This tester now omits all three.';
  }
  if (detail.includes('45-second') || detail.includes('timed out')) {
    return 'Retry once. If it repeats, the provider or one of its upstream routes is taking longer than the test limit.';
  }
  if (result.httpStatus === 400) {
    return 'The provider rejected a request parameter. Compare the exact JSON and cURL below with that provider’s model documentation.';
  }
  if (result.httpStatus === 401 || result.httpStatus === 403) {
    return 'Check that the API key is valid and allowed to use this model.';
  }
  if (result.httpStatus === 404) {
    return 'Check the base URL, API format, generated endpoint path, and model name.';
  }
  if (result.httpStatus === 429) {
    return 'The provider is rate-limiting the request or the account has reached a quota. Wait, reduce concurrency, or check balance.';
  }
  if (typeof result.httpStatus === 'number' && result.httpStatus >= 500) {
    return 'The provider or its upstream service failed. Retry later and send the request ID to the provider if it continues.';
  }
  if (!result.httpStatus) {
    return 'Retry once, then verify the base URL and provider availability. No upstream HTTP response was available.';
  }
  return 'Review the provider response and request ID below, then compare the exact request with the provider documentation.';
}

function RequestResponseDetails({ result }: { result: TestResult }) {
  const assessment = assessResult(result);
  const errorMessage = resultErrorMessage(result);
  const solution = errorSolution(result, errorMessage);
  const requestHeaders = formattedJson(result.requestHeaders);
  const requestBody = formattedJson(result.requestBody);
  const curl = buildInlineCurlCommand(result);
  const hasRequest =
    Boolean(result.requestMethod) ||
    Boolean(result.requestUrl) ||
    Boolean(result.requestBody);
  const hasDetails =
    Boolean(result.answer) ||
    Boolean(errorMessage) ||
    Boolean(result.rawResponse) ||
    hasRequest;
  if (!hasDetails) return null;

  return (
    <details className="mt-2 text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none font-medium text-foreground/70 hover:text-foreground">
        Request & response details
      </summary>
      <div className="mt-2 space-y-3 rounded-lg bg-muted/60 p-3 leading-5">
        <p>Completion: {String(assessment.completion)} · Capture: {assessment.capture} · Usage: {assessment.usageAvailability}</p>
        <p>Input: {assessment.inputSize} · Cache: {assessment.cache} (neutral observation)</p>
        <p>{[...assessment.issues, ...(Array.isArray(assessment.protocolFindings) ? assessment.protocolFindings : [])].join(" · ")}</p>
        <p>Evidence: {String(assessment.evidenceVersion)} · Analysis: {assessment.analysisVersion}</p>
        {errorMessage ? (
          <div className="rounded-md border border-rose-200 bg-rose-50 p-2.5">
            <p className="font-semibold text-rose-800">Error</p>
            <p className="mt-1 whitespace-pre-wrap text-rose-700">
              {errorMessage}
            </p>
            {solution ? (
              <p className="mt-2 text-amber-900">
                <span className="font-semibold">How to fix:</span> {solution}
              </p>
            ) : null}
          </div>
        ) : result.answer ? (
          <div>
            <p className="font-semibold text-foreground">Answer</p>
            <p className="mt-1 whitespace-pre-wrap">{result.answer}</p>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px]">
          {result.httpStatus ? <span>HTTP {result.httpStatus}</span> : null}
          {result.returnedModel ? (
            <span>Model: {result.returnedModel}</span>
          ) : null}
          {result.requestId ? (
            <span className="break-all">Request ID: {result.requestId}</span>
          ) : null}
        </div>

        {routeEvidence(result.requestBody).requested && (() => {
          const route = routeEvidence(result.requestBody, result.rawResponse);
          return <p className="rounded-md border border-border p-2">Requested tier: {route.requested} · Served tier: {route.served || 'Not reported (unverified)'} · Provider: {route.provider || 'Not reported'} · Reported cost: {route.cost === null ? 'Not reported' : `$${route.cost.toFixed(6)}`}{route.served && route.served !== route.requested ? ' · Tier mismatch: exclude this result from the requested-tier comparison.' : ''}</p>;
        })()}
        {hasRequest ? (
          <details>
            <summary className="cursor-pointer font-semibold text-foreground">
              Exact request
            </summary>
            <div className="mt-2 space-y-2">
              <p className="break-all font-mono text-[10px] text-foreground">
                Actual request: {result.requestMethod || 'POST'}{' '}
                {result.requestUrl}
              </p>
              <p className="text-[10px]">
                Not sent: system, tools, explicit cache settings, temperature,
                top_p, or top_k. The API key is replaced with $API_KEY.
              </p>
              {requestHeaders ? (
                <>
                  <p className="font-semibold text-foreground">
                    Request headers
                  </p>
                  <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-md bg-slate-950 p-3 text-[10px] leading-4 text-slate-100">
                    {requestHeaders}
                  </pre>
                </>
              ) : null}
              {requestBody ? (
                <>
                  <p className="font-semibold text-foreground">JSON body</p>
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md bg-slate-950 p-3 text-[10px] leading-4 text-slate-100">
                    {requestBody}
                  </pre>
                </>
              ) : null}
              {curl ? (
                <>
                  <p className="font-semibold text-foreground">
                    Reproducible cURL
                  </p>
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md bg-slate-950 p-3 text-[10px] leading-4 text-slate-100">
                    {curl}
                  </pre>
                </>
              ) : null}
            </div>
          </details>
        ) : null}

        {result.rawResponse ? (
          <details>
            <summary className="cursor-pointer font-semibold text-foreground">
              Raw provider response
            </summary>
            <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md bg-slate-950 p-3 text-[10px] leading-4 text-slate-100">
              {result.rawResponse}
            </pre>
          </details>
        ) : null}
      </div>
    </details>
  );
}

function evidenceRun(context: RunContext, results: TestResult[]): EvidenceRun {
  const normalCount = results.filter(
    (result) => result.status === 'normal',
  ).length;
  const cacheCount = results.filter(
    (result) => result.status === 'cached',
  ).length;
  const largeCount = results.filter(
    (result) => result.status === 'large',
  ).length;
  const unavailableCount = results.filter(
    (result) => result.status === 'unavailable',
  ).length;
  const errorCount = results.filter(
    (result) => result.status === 'error',
  ).length;
  const completedCount =
    normalCount + cacheCount + largeCount + unavailableCount + errorCount;
  return {
    ...context,
    verdict:
      completedCount < NORMAL_QUESTIONS.length
        ? 'incomplete'
        : largeCount
          ? 'large'
          : errorCount || unavailableCount
              ? 'incomplete'
              : 'normal',
    normalCount,
    cacheCount,
    largeCount,
    unavailableCount,
    errorCount,
    medianTtftMs: median(results.map((result) => result.ttftMs)),
    medianGenerationMs: median(results.map((result) => result.generationMs)),
    medianTotalTimeMs: median(results.map((result) => result.totalTimeMs)),
    medianOutputTokensPerSecond: median(
      results.map((result) => result.outputTokensPerSecond),
      2,
    ),
  };
}

export function TokenCheckApp({
  signInPath,
  onRunningChange,
}: {
  signInPath: string;
  onRunningChange?: (running: boolean) => void;
}) {
  const { navigate } = useWorkspaceNavigation();
  const [user, setUser] = useState<User>(null);
  const [apiType, setApiType] = useState<ApiType>('anthropic');
  const [liveShownApiType, setShownApiType] = useState<ApiType>('anthropic');
  const [connections, setConnections] =
    useState<Record<ApiType, ConnectionSettings>>(DEFAULT_CONNECTIONS);
  const [apiKeys, setApiKeys] = useState<ApiKeys>(EMPTY_API_KEYS);
  const [draftTouched, setDraftTouched] =
    useState<DraftTouched>(EMPTY_DRAFT_TOUCHED);
  const [showKey, setShowKey] = useState(false);
  const [settingsReady, setSettingsReady] = useState(false);
  const [normalQueue] = useState(
    () => new NormalTestQueue<ApiResponse, RunContext>(),
  );
  const queueJobs = useSyncExternalStore(
    normalQueue.subscribe,
    normalQueue.getSnapshot,
    normalQueue.getSnapshot,
  );
  const [selectedJobId, setSelectedJobId] = useState('');
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [concurrency, setConcurrency] = useState(3);
  const [openRouterTier, setOpenRouterTier] = useState<OpenRouterTier>('default');
  const liveJob =
    queueJobs.find((job) => job.id === selectedJobId) ?? queueJobs.at(-1);
  const liveResults = (liveJob?.results ?? initialResults()) as TestResult[];
  const liveNormalPhase: NormalPhase = liveJob?.phase ?? 'idle';
  const isRunning = queueJobs.some((job) => isQueueActive(job.phase));
  const [isRpmRunning, setIsRpmRunning] = useState(false);
  const [isBoundaryRunning, setIsBoundaryRunning] = useState(false);
  const [isEndpointRunning, setIsEndpointRunning] = useState(false);
  const [testMode, setTestMode] = useState<TestMode>('normal');
  const [formError, setFormError] = useState('');
  const liveRunMessage =
    liveJob?.message ?? 'Ready for a new 12-question check.';
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const preferredLoaded = useRef(false);
  useEffect(() => {
    if (preferredLoaded.current || !profiles.length) return;
    preferredLoaded.current = true;
    const id = activeConnectionId();
    if (profiles.some(item => item.id === id)) selectProfile(id);
  }, [profiles]);
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [profileName, setProfileName] = useState('');
  const [profileModels, setProfileModels] =
    useState<ProfileModels>(EMPTY_PROFILE_MODELS);
  const [newModel, setNewModel] = useState('');
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileDirty, setProfileDirty] = useState(false);
  const [profileMessage, setProfileMessage] = useState('');
  const [runs, setRuns] = useState<SavedRunSummary[]>([]);
  const [savedConnectionFilter, setSavedConnectionFilter] = useState('');
  const [savedModelFilter, setSavedModelFilter] = useState('');
  const [savedApiTypeFilter, setSavedApiTypeFilter] = useState<'' | ApiType>(
    '',
  );
  const [savedTestTypeFilter, setSavedTestTypeFilter] = useState<'' | TestMode>(
    '',
  );
  const [viewMode, setViewMode] = useState<ViewMode>('current');
  const [resultsView, setResultsView] = useState<ResultsView>('tokens');
  const liveRunContext = liveJob?.context ?? null;
  const [savedPreview, setSavedPreview] = useState<{
    run: SavedRunSummary;
    results: TestResult[];
    diagnostic?: DiagnosticRun;
  } | null>(null);
  const [lastRunMode, setLastRunMode] = useState<TestMode | null>(null);
  const [rpmMessage, setRpmMessage] = useState('');
  const [historyBusy, setHistoryBusy] = useState(false);
  const previewRequestRef = useRef(0);
  const deletedDiagnosticIds = useRef(new Set<string>());
  const queueStartingRef = useRef(false);
  const controlsLocked =
    isRunning || isRpmRunning || isBoundaryRunning || isEndpointRunning;
  const connectionRefreshLocked = useRef(false);
  connectionRefreshLocked.current = controlsLocked || profileBusy;
  useEffect(() => { onRunningChange?.(controlsLocked); }, [controlsLocked, onRunningChange]);
  useEffect(() => {
    const refresh = () => {
      if (controlsLocked || profileBusy || !user) return;
      void jsonFetch<{ profiles: Profile[] }>('/api/profiles').then(data => {
        if (connectionRefreshLocked.current) return;
        setProfiles(data.profiles);
        const id = activeConnectionId();
        if (data.profiles.some(item => item.id === id)) selectProfile(id, data.profiles);
        else if (selectedProfileId && !data.profiles.some(item => item.id === selectedProfileId)) selectProfile('');
      }).catch(() => setProfileMessage('Could not refresh connections. Try again from Connections.'));
    };
    window.addEventListener('connections-refresh', refresh);
    return () => window.removeEventListener('connections-refresh', refresh);
  }, [controlsLocked, profileBusy, user, selectedProfileId]);
  // History is a read-only snapshot; it must never replace live runner state.
  const normalPreview =
    viewMode === 'detail' && savedPreview?.run.testKind === 'normal'
      ? savedPreview
      : null;
  const results = normalPreview?.results ?? liveResults;
  const normalPhase = normalPreview ? 'complete' : liveNormalPhase;
  const shownApiType =
    normalPreview?.run.apiType ?? liveJob?.context.apiType ?? liveShownApiType;
  const runContext: RunContext | null = normalPreview
    ? { ...normalPreview.run, source: 'saved' }
    : liveRunContext;
  const runMessage = normalPreview
    ? `Saved run from ${new Date(normalPreview.run.createdAt).toLocaleString()}.`
    : liveRunMessage;
  useEffect(() => () => normalQueue.stopAll(), [normalQueue]);

  function showCurrent(mode = testMode) {
    previewRequestRef.current += 1;
    setTestMode(mode);
    setViewMode('current');
  }

  function showHistory() {
    previewRequestRef.current += 1;
    setViewMode('saved');
  }

  function showJobHistory(id: string) {
    const job = queueJobs.find((item) => item.id === id);
    if (!job?.context.id) return;
    setSavedConnectionFilter(job.context.profileName || 'One-time connection');
    setSavedModelFilter(job.context.modelName);
    setSavedApiTypeFilter(job.context.apiType);
    setSavedTestTypeFilter('normal');
    showHistory();
  }

  function onHistoryAssigned(id: string, profileId: string, name: string) {
    const update = (run: SavedRunSummary) =>
      run.id === id ? { ...run, profileId, profileName: name } : run;
    setRuns((current) => current.map(update));
    setSavedPreview((current) =>
      current ? { ...current, run: update(current.run) } : null,
    );
  }

  function onRpmRunningChange(running: boolean) {
    setIsRpmRunning(running);
    if (running) setLastRunMode('rpm');
  }
  const { baseUrl, model } = connections[apiType];
  const apiKey = apiKeys[apiType];
  const activeProfileModels = profileModels[apiType];
  const selectedProfile =
    profiles.find((profile) => profile.id === selectedProfileId) ?? null;
  const selectedProfileConfig = selectedProfile?.configs[apiType] ?? null;
  const modelChoices = [
    ...new Set(
      [...activeProfileModels, model.trim(), ...selectedModels].filter(Boolean),
    ),
  ];
  const modelsToEnqueue = selectedModels.length
    ? selectedModels
    : model.trim()
      ? [model.trim()]
      : [];
  const savedConnectionNames = useMemo(
    () =>
      Array.from(
        new Set(
          runs.map((run) => run.profileName?.trim() || 'One-time connection'),
        ),
      ).sort((left, right) => left.localeCompare(right)),
    [runs],
  );
  const savedModelNames = useMemo(
    () =>
      Array.from(new Set(runs.map((run) => run.modelName))).sort(
        (left, right) => left.localeCompare(right),
      ),
    [runs],
  );
  const filteredRuns = useMemo(
    () =>
      runs.filter((run) => {
        const connectionName = run.profileName?.trim() || 'One-time connection';
        return (
          (!savedConnectionFilter ||
            connectionName === savedConnectionFilter) &&
          (!savedModelFilter || run.modelName === savedModelFilter) &&
          (!savedApiTypeFilter || run.apiType === savedApiTypeFilter) &&
          (!savedTestTypeFilter || run.testKind === savedTestTypeFilter)
        );
      }),
    [
      runs,
      savedApiTypeFilter,
      savedConnectionFilter,
      savedModelFilter,
      savedTestTypeFilter,
    ],
  );
  const hasSavedRunFilters = Boolean(
    savedConnectionFilter ||
    savedModelFilter ||
    savedApiTypeFilter ||
    savedTestTypeFilter,
  );

  function updateConnection(
    patch: Partial<ConnectionSettings>,
    forType = apiType,
  ) {
    setConnections((current) => ({
      ...current,
      [forType]: { ...current[forType], ...patch },
    }));
  }

  function markDraftTouched(
    fields: Array<keyof DraftTouched[ApiType]>,
    forType = apiType,
  ) {
    setDraftTouched((current) => ({
      ...current,
      [forType]: {
        ...current[forType],
        ...Object.fromEntries(fields.map((field) => [field, true])),
      },
    }));
  }

  function updateApiKey(value: string, forType = apiType) {
    setApiKeys((current) => ({ ...current, [forType]: value }));
    markDraftTouched(['apiKey'], forType);
  }

  function updateProfileModels(models: string[], forType = apiType) {
    setProfileModels((current) => ({ ...current, [forType]: models }));
    markDraftTouched(['models'], forType);
  }

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(SETTINGS_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as {
          apiType?: ApiType;
          connections?: Partial<Record<ApiType, Partial<ConnectionSettings>>>;
          touched?: Partial<
            Record<
              ApiType,
              Partial<Pick<DraftTouched[ApiType], 'baseUrl' | 'model'>>
            >
          >;
        };
        if (parsed.apiType === 'anthropic' || parsed.apiType === 'openai') {
          setApiType(parsed.apiType);
          setShownApiType(parsed.apiType);
        }
        if (parsed.connections) {
          setConnections({
            anthropic: {
              ...DEFAULT_CONNECTIONS.anthropic,
              ...parsed.connections.anthropic,
            },
            openai: {
              ...DEFAULT_CONNECTIONS.openai,
              ...parsed.connections.openai,
            },
          });
        }
        setDraftTouched({
          anthropic: {
            ...EMPTY_DRAFT_TOUCHED.anthropic,
            ...parsed.touched?.anthropic,
          },
          openai: {
            ...EMPTY_DRAFT_TOUCHED.openai,
            ...parsed.touched?.openai,
          },
        });
      } else {
        const v3 = window.localStorage.getItem(V3_SETTINGS_KEY);
        const old = window.localStorage.getItem(OLD_SETTINGS_KEY);
        const legacy = window.localStorage.getItem(LEGACY_SETTINGS_KEY);
        if (v3) {
          const parsed = JSON.parse(v3) as {
            apiType?: ApiType;
            connections?: Partial<Record<ApiType, Partial<ConnectionSettings>>>;
          };
          const nextType = parsed.apiType === 'openai' ? 'openai' : 'anthropic';
          setApiType(nextType);
          setShownApiType(nextType);
          const migratedConnections = {
            anthropic: {
              ...DEFAULT_CONNECTIONS.anthropic,
              ...parsed.connections?.anthropic,
            },
            openai: {
              ...DEFAULT_CONNECTIONS.openai,
              ...parsed.connections?.openai,
            },
          };
          setConnections(migratedConnections);
          setDraftTouched(migratedDraftTouched(migratedConnections, nextType));
        } else if (old) {
          const parsed = JSON.parse(old) as {
            apiFormat?: ApiType;
            connections?: Partial<
              Record<ApiType, { endpoint?: string; model?: string }>
            >;
          };
          const nextType =
            parsed.apiFormat === 'openai' ? 'openai' : 'anthropic';
          setApiType(nextType);
          setShownApiType(nextType);
          const migratedConnections = {
            anthropic: {
              baseUrl: stripEndpoint(
                parsed.connections?.anthropic?.endpoint ??
                  DEFAULT_CONNECTIONS.anthropic.baseUrl,
                'anthropic',
              ),
              model:
                parsed.connections?.anthropic?.model ??
                DEFAULT_CONNECTIONS.anthropic.model,
            },
            openai: {
              baseUrl: stripEndpoint(
                parsed.connections?.openai?.endpoint ??
                  DEFAULT_CONNECTIONS.openai.baseUrl,
                'openai',
              ),
              model:
                parsed.connections?.openai?.model ??
                DEFAULT_CONNECTIONS.openai.model,
            },
          };
          setConnections(migratedConnections);
          setDraftTouched(migratedDraftTouched(migratedConnections, nextType));
        } else if (legacy) {
          const parsed = JSON.parse(legacy) as {
            endpoint?: string;
            model?: string;
          };
          const migratedConnections = {
            ...DEFAULT_CONNECTIONS,
            anthropic: {
              baseUrl: stripEndpoint(
                parsed.endpoint ?? DEFAULT_CONNECTIONS.anthropic.baseUrl,
                'anthropic',
              ),
              model: parsed.model ?? DEFAULT_CONNECTIONS.anthropic.model,
            },
          };
          setConnections(migratedConnections);
          setDraftTouched(
            migratedDraftTouched(migratedConnections, 'anthropic'),
          );
        }
      }
    } catch {
      // Broken device-local settings fall back to official provider examples.
    } finally {
      setSettingsReady(true);
    }
    void jsonFetch<{ user: User }>('/api/session')
      .then((session) => {
        setUser(session.user);
        if (!session.user) return;
        return Promise.all([
          jsonFetch<{ profiles: Profile[] }>('/api/profiles').then(data => { setProfiles(data.profiles); return data; }),
          jsonFetch<{ runs: Array<Omit<RunSummary, 'testKind'>> }>('/api/runs'),
          jsonFetch<{ runs: RpmRunSummary[] }>('/api/rpm-runs'),
          jsonFetch<{ runs: DiagnosticRunSummary[] }>('/api/diagnostic-runs'),
        ]).then(([profilesData, runsData, rpmRunsData, diagnosticRunsData]) => {
          setProfiles(profilesData.profiles);
          setRuns(
            [
              ...runsData.runs.map((run) => ({
                ...run,
                testKind: 'normal' as const,
              })),
              ...rpmRunsData.runs,
              ...diagnosticRunsData.runs,
            ].sort((left, right) => right.createdAt - left.createdAt),
          );
        });
      })
      .catch((error: unknown) => {
        setProfileMessage(
          error instanceof Error ? error.message : 'Could not load saved data.',
        );
      });
  }, []);

  useEffect(() => {
    if (!settingsReady || selectedProfileId) return;
    window.localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        apiType,
        connections,
        touched: {
          anthropic: {
            baseUrl: draftTouched.anthropic.baseUrl,
            model: draftTouched.anthropic.model,
          },
          openai: {
            baseUrl: draftTouched.openai.baseUrl,
            model: draftTouched.openai.model,
          },
        },
      }),
    );
  }, [apiType, connections, draftTouched, selectedProfileId, settingsReady]);

  useEffect(() => {
    if (
      savedConnectionFilter &&
      !savedConnectionNames.includes(savedConnectionFilter)
    ) {
      setSavedConnectionFilter('');
    }
    if (savedModelFilter && !savedModelNames.includes(savedModelFilter)) {
      setSavedModelFilter('');
    }
  }, [
    savedConnectionFilter,
    savedConnectionNames,
    savedModelFilter,
    savedModelNames,
  ]);

  const completed = results.filter((result) =>
    ['normal', 'cached', 'large', 'unavailable', 'error'].includes(
      result.status,
    ),
  ).length;
  const normalCount = results.filter(
    (result) => result.status === 'normal',
  ).length;
  const cacheCount = results.filter(
    (result) => result.status === 'cached',
  ).length;
  const largeCount = results.filter(
    (result) => result.status === 'large',
  ).length;
  const unavailableCount = results.filter(
    (result) => result.status === 'unavailable',
  ).length;
  const errorCount = results.filter(
    (result) => result.status === 'error',
  ).length;
  const progress = Math.round((completed / NORMAL_QUESTIONS.length) * 100);
  const outcomeSource = {
    normalCount,
    cacheCount,
    largeCount,
    errorCount,
    unavailableCount,
  };
  const performanceSummary = useMemo(
    () => ({
      measuredCount: results.filter(
        (result) => typeof result.ttftMs === 'number',
      ).length,
      medianTtftMs: median(results.map((result) => result.ttftMs)),
      medianGenerationMs: median(results.map((result) => result.generationMs)),
      medianTotalTimeMs: median(results.map((result) => result.totalTimeMs)),
      medianOutputTokensPerSecond: median(
        results.map((result) => result.outputTokensPerSecond),
        2,
      ),
    }),
    [results],
  );

  const overall = useMemo(() => {
    if (normalPhase === 'queued')
      return {
        tone: 'ready',
        title: 'Model queued',
        description:
          'This model will start automatically when a parallel slot opens.',
      };
    if (normalPhase === 'running')
      return {
        tone: 'running',
        title: `Testing question ${Math.min(completed + 1, 12)} of 12`,
        description:
          'Each request uses no system prompt, tools, or explicit cache settings.',
      };
    if (normalPhase === 'stopping')
      return {
        tone: 'running',
        title: 'Stopping test…',
        description:
          'Cancelling the active request and closing every unfinished question.',
      };
    if (normalPhase === 'saving')
      return {
        tone: 'running',
        title: 'Saving completed test…',
        description: 'All 12 responses finished. Saving the run privately.',
      };
    if (normalPhase === 'stopped') {
      const partialEvidence = [
        largeCount
          ? `${largeCount} elevated-input result${largeCount === 1 ? '' : 's'}`
          : null,
        errorCount
          ? `${errorCount} failed request${errorCount === 1 ? '' : 's'}`
          : null,
      ].filter(Boolean);
      return {
        tone: 'warning',
        title:
          completed === 0
            ? 'Test stopped'
            : completed === NORMAL_QUESTIONS.length
              ? 'Test stopped after all responses completed'
              : 'Test stopped — partial results',
        description:
          completed === 0
            ? 'Stopped before any question completed. No result was saved.'
            : completed === NORMAL_QUESTIONS.length
              ? 'All 12 requests completed, but the run was stopped before it was saved. The displayed evidence can still be exported.'
              : `${completed} of 12 questions completed. No full-run token verdict was produced or saved automatically.${partialEvidence.length ? ` Partial evidence includes ${partialEvidence.join(' and ')}.` : ''}`,
      };
    }
    if (!completed)
      return {
        tone: 'ready',
        title: 'Ready to check',
        description:
          'Short prompts usually have small reported inputs. Cache use is shown separately and is not an error by itself.',
      };
    return {
      tone: 'ready',
      title: normalOutcomeTitle({
        normalCount,
        cacheCount,
        largeCount,
        errorCount,
        unavailableCount,
      }),
      description: `${completed} / ${NORMAL_QUESTIONS.length} requests finished · ${completed < NORMAL_QUESTIONS.length ? 'Partial run' : errorCount ? `Completed with ${errorCount} failure${errorCount === 1 ? '' : 's'}` : largeCount ? 'Completed with elevated input' : unavailableCount ? 'Completed with results needing review' : 'Completed'}.${unavailableCount ? ` Completion, protocol or usage needs review for ${unavailableCount} request${unavailableCount === 1 ? '' : 's'}.` : ''}`,
    };
  }, [
    cacheCount,
    completed,
    errorCount,
    largeCount,
    normalPhase,
    normalCount,
    unavailableCount,
  ]);

  function chooseType(nextType: ApiType) {
    if (controlsLocked || profileBusy || nextType === apiType) return;
    const sourceType = apiType;
    const targetTouched = draftTouched[nextType];
    const copyBaseUrl = !targetTouched.baseUrl;
    const copyModel = !targetTouched.model;
    const copyApiKey = !targetTouched.apiKey && Boolean(apiKeys[sourceType]);
    const copyModels =
      !targetTouched.models && profileModels[sourceType].length > 0;
    setConnections((current) => ({
      ...current,
      [nextType]: {
        baseUrl: copyBaseUrl
          ? current[sourceType].baseUrl
          : current[nextType].baseUrl,
        model: copyModel ? current[sourceType].model : current[nextType].model,
      },
    }));
    if (copyApiKey) {
      setApiKeys((current) => ({
        ...current,
        [nextType]: current[sourceType],
      }));
    }
    if (copyModels) {
      setProfileModels((current) => ({
        ...current,
        [nextType]: [...current[sourceType]],
      }));
    }
    const sourceFields = [
      ...(copyBaseUrl ? (['baseUrl'] as const) : []),
      ...(copyModel && connections[sourceType].model
        ? (['model'] as const)
        : []),
      ...(copyApiKey ? (['apiKey'] as const) : []),
      ...(copyModels ? (['models'] as const) : []),
    ];
    if (sourceFields.length) {
      // The source becomes the stable value; the untouched target can keep
      // following it until the user edits that target directly.
      markDraftTouched(sourceFields, sourceType);
    }
    setApiType(nextType);
    setSelectedModels([]);
    setShowKey(false);
    setFormError('');
  }

  function selectProfile(id: string, availableProfiles = profiles) {
    if (controlsLocked || profileBusy) return;
    setSelectedProfileId(id);
    rememberConnection(id);
    setSelectedModels([]);
    setProfileMessage('');
    setProfileDirty(false);
    setApiKeys(EMPTY_API_KEYS);
    setShowKey(false);
    if (!id) {
      setProfileName('');
      setProfileModels(EMPTY_PROFILE_MODELS);
      setDraftTouched(EMPTY_DRAFT_TOUCHED);
      return;
    }
    const profile = availableProfiles.find((item) => item.id === id);
    if (!profile) return;
    setProfileName(profile.name);
    setProfileModels({
      anthropic: profile.configs.anthropic.models,
      openai: profile.configs.openai.models,
    });
    setConnections({
      anthropic: {
        baseUrl: profile.configs.anthropic.baseUrl,
        model: profile.configs.anthropic.model,
      },
      openai: {
        baseUrl: profile.configs.openai.baseUrl,
        model: profile.configs.openai.model,
      },
    });
    setDraftTouched({
      anthropic: {
        baseUrl: true,
        model: true,
        apiKey: true,
        models: true,
      },
      openai: {
        baseUrl: true,
        model: true,
        apiKey: true,
        models: true,
      },
    });
    setApiType(profile.defaultApiType);
  }

  function addModel() {
    const next = newModel.trim();
    if (!next || next.length > 120) return;
    updateProfileModels([...new Set([...activeProfileModels, next])]);
    if (selectedProfileId) setProfileDirty(true);
    updateConnection({ model: next });
    markDraftTouched(['model']);
    setNewModel('');
  }

  function removeModel(item: string) {
    if (controlsLocked || profileBusy) return;
    setSelectedModels((current) => current.filter((name) => name !== item));
    const next = activeProfileModels.filter((modelName) => modelName !== item);
    updateProfileModels(next);
    if (selectedProfileId) setProfileDirty(true);
    if (model === item) {
      updateConnection({ model: next[0] ?? '' });
      markDraftTouched(['model']);
    }
  }

  function profileConfigDraft(type: ApiType) {
    const useOwn = type === apiType;
    const touched = draftTouched[type];
    const baseUrlValue =
      useOwn || touched.baseUrl ? connections[type].baseUrl : baseUrl;
    const modelValue =
      useOwn || touched.model ? connections[type].model : model;
    const modelList =
      useOwn || touched.models || touched.model
        ? profileModels[type]
        : activeProfileModels;
    const keyValue =
      useOwn || touched.apiKey ? apiKeys[type] : apiKeys[apiType];
    return {
      baseUrl: baseUrlValue,
      model: modelValue,
      models: [...new Set([...modelList, modelValue].filter(Boolean))],
      apiKey: keyValue,
    };
  }

  async function saveProfile() {
    if (!user) return;
    if (
      !confirmHttpRisk(
        Object.values(connections).map((config) => config.baseUrl),
        (message) => window.confirm(message),
      )
    )
      return;
    setProfileMessage('');
    setProfileBusy(true);
    const configs = {
      anthropic: profileConfigDraft('anthropic'),
      openai: profileConfigDraft('openai'),
    };
    try {
      const data = await jsonFetch<{ profile: Profile }>(
        selectedProfileId
          ? `/api/profiles/${selectedProfileId}`
          : '/api/profiles',
        {
          method: selectedProfileId ? 'PATCH' : 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: profileName,
            defaultApiType: apiType,
            configs,
          }),
        },
      );
      setProfiles((current) => [
        data.profile,
        ...current.filter((item) => item.id !== data.profile.id),
      ]);
      setSelectedProfileId(data.profile.id);
      setConnections({
        anthropic: {
          baseUrl: data.profile.configs.anthropic.baseUrl,
          model: data.profile.configs.anthropic.model,
        },
        openai: {
          baseUrl: data.profile.configs.openai.baseUrl,
          model: data.profile.configs.openai.model,
        },
      });
      setProfileModels({
        anthropic: data.profile.configs.anthropic.models,
        openai: data.profile.configs.openai.models,
      });
      setApiKeys(EMPTY_API_KEYS);
      setDraftTouched({
        anthropic: {
          baseUrl: true,
          model: true,
          apiKey: true,
          models: true,
        },
        openai: {
          baseUrl: true,
          model: true,
          apiKey: true,
          models: true,
        },
      });
      setProfileDirty(false);
      setProfileMessage(
        selectedProfileId ? 'Profile updated.' : 'Profile saved securely.',
      );
    } catch (error) {
      setProfileMessage(
        error instanceof Error ? error.message : 'Could not save this profile.',
      );
    } finally {
      setProfileBusy(false);
    }
  }

  async function rememberProfileModels(
    profileId: string,
    forType: ApiType,
    forBaseUrl: string,
    models?: string[],
  ) {
    const data = await jsonFetch<{
      profileId: string;
      apiType: ApiType;
      models: string[];
      added: number;
    }>(`/api/profiles/${profileId}/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        apiType: forType,
        baseUrl: forBaseUrl,
        ...(models ? { models } : { source: 'history' }),
      }),
    });
    setProfiles((current) =>
      current.map((profile) =>
        profile.id !== profileId
          ? profile
          : {
              ...profile,
              configs: {
                ...profile.configs,
                [forType]: { ...profile.configs[forType], models: data.models },
              },
            },
      ),
    );
    // Connection edits are locked while awaiting this response. Preserve other API
    // settings and any additional model drafts; never replace the key or default model.
    setProfileModels((current) => ({
      ...current,
      [forType]: [...new Set([...data.models, ...current[forType]])],
    }));
    return data;
  }

  async function restoreHistoryModels() {
    if (
      !selectedProfileId ||
      controlsLocked ||
      profileBusy ||
      queueStartingRef.current
    )
      return;
    queueStartingRef.current = true;
    setProfileBusy(true);
    setProfileMessage('');
    try {
      const data = await rememberProfileModels(
        selectedProfileId,
        apiType,
        baseUrl,
      );
      setProfileMessage(
        data.added
          ? `${data.added} models restored and saved for ${apiType === 'anthropic' ? 'Anthropic' : 'OpenAI'}. No tests were sent.`
          : 'All historical models are already saved. No tests were sent.',
      );
    } catch (error) {
      setProfileMessage(
        error instanceof Error ? error.message : 'Could not restore models.',
      );
    } finally {
      queueStartingRef.current = false;
      setProfileBusy(false);
    }
  }

  async function deleteProfile() {
    if (!selectedProfileId || !user) return;
    setProfileBusy(true);
    try {
      await jsonFetch<{ deleted: boolean }>(
        `/api/profiles/${selectedProfileId}`,
        { method: 'DELETE' },
      );
      setProfiles((current) =>
        current.filter((profile) => profile.id !== selectedProfileId),
      );
      setSelectedProfileId('');
      setProfileName('');
      setProfileModels(EMPTY_PROFILE_MODELS);
      setApiKeys(EMPTY_API_KEYS);
      setDraftTouched(EMPTY_DRAFT_TOUCHED);
      setProfileDirty(false);
      setProfileMessage(
        'Profile deleted. Existing saved runs remain available.',
      );
    } catch (error) {
      setProfileMessage(
        error instanceof Error
          ? error.message
          : 'Could not delete this profile.',
      );
    } finally {
      setProfileBusy(false);
    }
  }

  async function saveCompletedRun(
    finishedResults: TestResult[],
    context: RunContext,
    profileId: string | null,
  ) {
    const data = await jsonFetch<{
      run: Omit<RunSummary, 'testKind'>;
    }>('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        profileId,
        profileName: context.profileName,
        apiType: context.apiType,
        baseUrl: context.baseUrl,
        model: context.modelName,
        results: finishedResults,
      }),
    });
    const savedRun: RunSummary = { ...data.run, testKind: 'normal' };
    setRuns((current) => [
      savedRun,
      ...current.filter((run) => run.id !== savedRun.id),
    ]);
    return { ...context, id: savedRun.id, profileName: savedRun.profileName };
  }

  function exportEvidence(context: RunContext, exportedResults: TestResult[]) {
    downloadEvidenceArchive(
      evidenceRun(context, exportedResults),
      exportedResults,
    );
  }

  async function exportSavedRun(run: SavedRunSummary) {
    if (run.testKind === 'boundary' || run.testKind === 'endpoints') {
      window.location.href = `/api/diagnostic-runs/${run.id}/export`;
      return;
    }
    if (run.testKind === 'rpm') {
      window.location.href = `/api/rpm-runs/${run.id}/export`;
      return;
    }
    setHistoryBusy(true);
    try {
      const data = await jsonFetch<{
        run: RunSummary;
        results: Array<TestResult & { questionId: string }>;
      }>(`/api/runs/${run.id}`);
      exportEvidence(
        {
          id: data.run.id,
          source: 'saved',
          profileName: data.run.profileName,
          apiType: data.run.apiType,
          baseUrl: data.run.baseUrl,
          modelName: data.run.modelName,
          createdAt: data.run.createdAt,
        },
        data.results.map((result) => ({ ...result, id: result.questionId })),
      );
    } catch (error) {
      setProfileMessage(
        error instanceof Error
          ? error.message
          : 'Could not export this saved run.',
      );
    } finally {
      setHistoryBusy(false);
    }
  }

  async function runTests(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      isRpmRunning ||
      isBoundaryRunning ||
      isEndpointRunning ||
      profileBusy ||
      queueStartingRef.current
    )
      return;
    setFormError('');
    if (profileName.trim().length > 80)
      return setFormError(
        'Use a connection / history name of up to 80 characters.',
      );
    if (selectedProfileId && profileName.trim() !== selectedProfile?.name)
      return setFormError(
        'Save the connection name change before starting, so the saved profile and test history agree.',
      );
    const baseUrlError = clientBaseUrlError(baseUrl.trim());
    if (baseUrlError) return setFormError(baseUrlError);
    if (!selectedProfileId && !apiKey.trim())
      return setFormError('Enter your API key, or choose a saved profile.');
    if (
      selectedProfileId &&
      (baseUrl.trim() !== selectedProfileConfig?.baseUrl || apiKey.trim())
    )
      return setFormError(
        'Save your URL or key changes before running the test.',
      );
    if (
      !modelsToEnqueue.length ||
      modelsToEnqueue.some((name) => name.length > 120)
    )
      return setFormError(
        'Select valid model names (up to 120 characters each).',
      );

    if (!confirmHttpRisk([baseUrl], (message) => window.confirm(message)))
      return;
    // Capture immutable connection/model values for both requests and saving.
    // Only the private task closures capture a one-time API key.
    const profileId = selectedProfileId || null;
    queueStartingRef.current = true;
    if (profileId) setProfileBusy(true);
    try {
      if (profileId)
        await rememberProfileModels(
          profileId,
          apiType,
          baseUrl.trim(),
          modelsToEnqueue,
        );
      const routingTier = apiType === 'openai' && isOpenRouter(baseUrl) && modelsToEnqueue.every(name => name.startsWith('openai/')) ? openRouterTier : undefined;
      const requestBase = {
        openRouterTier: routingTier,
        allowInsecureHttp: isInsecureHttp(baseUrl),
        profileId: profileId || undefined,
        apiType,
        baseUrl: profileId ? undefined : baseUrl.trim(),
        apiKey: profileId ? undefined : apiKey.trim(),
      };
      normalQueue.setConcurrency(concurrency);
      const ids = normalQueue.enqueue(
        modelsToEnqueue.map((modelName) => ({
          key: JSON.stringify([profileId, apiType, baseUrl.trim(), modelName, routingTier]),
          context: {
            source: 'current' as const,
            profileName: ((routingTier ? (selectedProfile?.name ?? profileName.trim()).slice(0, 55) : (selectedProfile?.name ?? profileName.trim())) + (routingTier ? ` · ${routingTier === 'flex' ? 'Flex' : 'Standard'} requested` : '')) || null,
            apiType,
            baseUrl: baseUrl.trim(),
            modelName,
            createdAt: Date.now(),
          },
          questions: NORMAL_QUESTIONS,
          request: (
            question: NormalQuestion,
            _index: number,
            signal: AbortSignal,
          ) =>
            testFetch({
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                ...requestBase,
                model: modelName,
                prompt: question.prompt,
              }),
              signal,
            }),
          classify: classifyResult,
          save: user
            ? (finished: TestResult[], context: RunContext) =>
                saveCompletedRun(finished, context, profileId)
            : undefined,
        })),
      );
      if (!ids.length)
        return setFormError(
          'Those models are already running or queued. Select a different model.',
        );
      if (!isRunning) setSelectedJobId(ids[0]);
      setSelectedModels([]);
      showCurrent('normal');
      setLastRunMode('normal');
      setShownApiType(apiType);
    } catch (error) {
      setFormError(
        `Could not save the batch model list. No new tests were started. ${error instanceof Error ? error.message : 'Try again.'}`,
      );
    } finally {
      queueStartingRef.current = false;
      if (profileId) setProfileBusy(false);
    }
  }

  function stopNormalTest() {
    if (liveJob) normalQueue.stop(liveJob.id);
  }

  async function openRun(run: SavedRunSummary) {
    const requestId = ++previewRequestRef.current;
    if (run.testKind === 'rpm') {
      setSavedPreview({ run, results: [] });
      setViewMode('detail');
      return;
    }
    setHistoryBusy(true);
    try {
      if (run.testKind === 'boundary' || run.testKind === 'endpoints') {
        const data = await jsonFetch<{
          run: DiagnosticRunSummary;
          document: DiagnosticRun;
        }>(`/api/diagnostic-runs/${run.id}`);
        if (previewRequestRef.current !== requestId) return;
        setSavedPreview({
          run: data.run,
          results: [],
          diagnostic: data.document,
        });
        setViewMode('detail');
        return;
      }
      const data = await jsonFetch<{
        run: RunSummary;
        results: Array<TestResult & { questionId: string }>;
      }>(`/api/runs/${run.id}`);
      if (previewRequestRef.current !== requestId) return;
      setSavedPreview({
        run: { ...data.run, testKind: 'normal' },
        results: data.results.map((result) => ({
          ...result,
          id: result.questionId,
        })),
      });
      setViewMode('detail');
    } catch (error) {
      setProfileMessage(
        error instanceof Error
          ? error.message
          : 'Could not open this saved run.',
      );
    } finally {
      setHistoryBusy(false);
    }
  }

  async function deleteRun(run: SavedRunSummary) {
    if (
      run.testKind === 'rpm' &&
      ['preflight', 'ready', 'running'].includes(run.status)
    )
      return;
    setHistoryBusy(true);
    try {
      await jsonFetch<{ deleted: boolean }>(
        run.testKind === 'rpm'
          ? `/api/rpm-runs/${run.id}`
          : run.testKind === 'normal'
            ? `/api/runs/${run.id}`
            : `/api/diagnostic-runs/${run.id}`,
        {
          method: 'DELETE',
        },
      );
      if (run.testKind === 'boundary' || run.testKind === 'endpoints')
        deletedDiagnosticIds.current.add(run.id);
      setRuns((current) => current.filter((item) => item.id !== run.id));
      if (savedPreview?.run.id === run.id) {
        setSavedPreview(null);
        showHistory();
      }
    } catch (error) {
      setProfileMessage(
        error instanceof Error ? error.message : 'Could not delete this run.',
      );
    } finally {
      setHistoryBusy(false);
    }
  }

  function upsertDiagnosticRun(run: DiagnosticRunSummary) {
    if (deletedDiagnosticIds.current.has(run.id)) return;
    setRuns((current) =>
      [run, ...current.filter((item) => item.id !== run.id)].sort(
        (a, b) => b.createdAt - a.createdAt,
      ),
    );
  }

  function upsertRpmRun(run: RpmRunSummary) {
    setRuns((current) =>
      [run, ...current.filter((item) => item.id !== run.id)].sort(
        (left, right) => right.createdAt - left.createdAt,
      ),
    );
  }

  function resetResults() {
    if (controlsLocked) return;
    normalQueue.clear();
    setSelectedJobId('');
    setShownApiType(apiType);
    setFormError('');
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto w-full max-w-[1480px] px-4 py-5 sm:px-6 lg:px-10 lg:py-8">
        <header className="mb-6 flex flex-col gap-4 border-b border-border/80 pb-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="mb-3 flex items-center gap-2">
              <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground shadow-sm">
                <Activity className="size-4" />
              </span>
              <span className="font-mono text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                CCMAX diagnostics
              </span>
            </div>
            <h1 className="font-heading text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">
              API Diagnostics
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
              Check token usage, compare three API endpoints, inspect tool
              self-description and measure request-rate capacity.
            </p>
          </div>

        </header>

        <nav className="mb-5 flex justify-end"><Link href="/connections" className="rounded-lg border border-border bg-card px-4 py-2 text-sm font-semibold text-primary hover:bg-muted">Manage connections</Link></nav>

        <section
          className="mb-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3"
          aria-label="Choose a test"
        >
          <Link href="/pelican" className="flex items-start gap-4 rounded-2xl border border-border bg-card p-4 text-left shadow-sm transition-colors hover:border-primary/40">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted"><Code2 className="size-5" /></span>
            <span><span className="block text-sm font-semibold">Pelican Animation Test</span><span className="mt-1 block text-sm leading-5 text-muted-foreground">One prompt · generate and preview an SVG animation</span></span>
          </Link>
          <button
            type="button"
            aria-pressed={testMode === 'normal'}
            onClick={() => showCurrent('normal')}
            className={`flex items-start gap-4 rounded-2xl border p-4 text-left shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${testMode === 'normal' ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card hover:border-primary/40'}`}
          >
            <span
              className={`grid size-10 shrink-0 place-items-center rounded-xl ${testMode === 'normal' ? 'bg-white/15' : 'bg-muted'}`}
            >
              <ListChecks className="size-5" />
            </span>
            <span>
              <span className="block text-sm font-semibold">
                Normal Token Check
              </span>
              <span
                className={`mt-1 block text-xs leading-5 ${testMode === 'normal' ? 'text-primary-foreground/75' : 'text-muted-foreground'}`}
              >
                12 ordinary questions · token/cache verdict + latency
              </span>
            </span>
          </button>
          <button
            type="button"
            aria-pressed={testMode === 'rpm'}
            onClick={() => showCurrent('rpm')}
            className={`flex items-start gap-4 rounded-2xl border p-4 text-left shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${testMode === 'rpm' ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card hover:border-primary/40'}`}
          >
            <span
              className={`grid size-10 shrink-0 place-items-center rounded-xl ${testMode === 'rpm' ? 'bg-white/15' : 'bg-muted'}`}
            >
              <Gauge className="size-5" />
            </span>
            <span>
              <span className="block text-sm font-semibold">RPM Ramp Test</span>
              <span
                className={`mt-1 block text-xs leading-5 ${testMode === 'rpm' ? 'text-primary-foreground/75' : 'text-muted-foreground'}`}
              >
                Staged capacity · stops after the first failed stage
              </span>
            </span>
          </button>
          <button
            type="button"
            aria-pressed={testMode === 'boundary'}
            onClick={() => showCurrent('boundary')}
            className={`flex items-start gap-4 rounded-2xl border p-4 text-left shadow-sm transition-colors ${testMode === 'boundary' ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card hover:border-primary/40'}`}
          >
            <span
              className={`grid size-10 shrink-0 place-items-center rounded-xl ${testMode === 'boundary' ? 'bg-white/15' : 'bg-muted'}`}
            >
              <ShieldCheck className="size-5" />
            </span>
            <span>
              <span className="block text-sm font-semibold">
                Tool Boundary Probe
              </span>
              <span
                className={`mt-1 block text-xs leading-5 ${testMode === 'boundary' ? 'text-primary-foreground/75' : 'text-muted-foreground'}`}
              >
                3 identical questions · full raw request / response
              </span>
            </span>
          </button>
          <button
            type="button"
            aria-pressed={testMode === 'endpoints'}
            onClick={() => showCurrent('endpoints')}
            className={`flex items-start gap-4 rounded-2xl border p-4 text-left shadow-sm transition-colors ${testMode === 'endpoints' ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card hover:border-primary/40'}`}
          >
            <span
              className={`grid size-10 shrink-0 place-items-center rounded-xl ${testMode === 'endpoints' ? 'bg-white/15' : 'bg-muted'}`}
            >
              <Code2 className="size-5" />
            </span>
            <span>
              <span className="block text-sm font-semibold">
                Three Endpoints
              </span>
              <span
                className={`mt-1 block text-xs leading-5 ${testMode === 'endpoints' ? 'text-primary-foreground/75' : 'text-muted-foreground'}`}
              >
                Messages · Chat Completions · Responses
              </span>
            </span>
          </button>
          <button
            type="button"
            aria-pressed={testMode === 'availability'}
            onClick={() => showCurrent('availability')}
            className={`flex items-start gap-4 rounded-2xl border p-4 text-left shadow-sm transition-colors ${testMode === 'availability' ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card hover:border-primary/40'}`}
          >
            <span
              className={`grid size-10 shrink-0 place-items-center rounded-xl ${testMode === 'availability' ? 'bg-white/15' : 'bg-muted'}`}
            >
              <Activity className="size-5" />
            </span>
            <span>
              <span className="block text-sm font-semibold">
                Availability Monitor
              </span>
              <span
                className={`mt-1 block text-xs leading-5 ${testMode === 'availability' ? 'text-primary-foreground/75' : 'text-muted-foreground'}`}
              >
                Every 10 minutes · model health history
              </span>
            </span>
          </button>
        </section>

        <div hidden={testMode !== 'availability'}>
          <AvailabilityMonitor
            key={user?.email || 'anonymous'}
            signedIn={Boolean(user)}
            signInPath={signInPath}
            profiles={profiles}
            active={testMode === 'availability'}
            onConnections={() => { if (!navigate('/connections')) window.location.assign('/connections'); }}
          />
        </div>

        <section
          style={testMode === 'availability' ? { display: 'none' } : undefined}
          className="space-y-5"
        >
          <form onSubmit={testMode === 'normal' ? runTests : event => event.preventDefault()} className="space-y-4 rounded-2xl border border-border bg-card p-4 shadow-sm">
            <div className="flex flex-wrap items-end gap-3">
              <label className="min-w-48 flex-1 text-sm font-medium">Connection
                <select value={selectedProfileId} onChange={event => selectProfile(event.target.value)} disabled={controlsLocked || profileBusy} className="mt-2 h-10 w-full rounded-lg border border-input bg-background px-3 text-sm">
                  <option value="">One-time connection</option>
                  {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                </select>
              </label>
              <label className="min-w-44 text-sm font-medium">API format
                <select value={apiType} onChange={event => chooseType(event.target.value as ApiType)} disabled={controlsLocked || profileBusy} className="mt-2 h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"><option value="anthropic">Anthropic</option><option value="openai">OpenAI</option></select>
              </label>
              <div className="min-w-48 flex-1 text-sm font-medium">Model
                {selectedProfileId ? <ModelPicker key={`${selectedProfileId}:${apiType}`} value={model} onChange={model => updateConnection({ model })} disabled={isRpmRunning || isBoundaryRunning || isEndpointRunning || profileBusy} models={activeProfileModels} /> : <Input aria-label="Model name" className="mt-2 h-10" value={model} onChange={event => updateConnection({ model: event.target.value })} disabled={isRpmRunning || isBoundaryRunning || isEndpointRunning || profileBusy} placeholder="Model name" />}
              </div>
              <Link href="/connections" className="inline-flex h-10 items-center rounded-lg border border-border px-4 text-sm font-semibold text-primary hover:bg-muted">Manage connections</Link>
              {testMode === 'normal' && <Button key="normal-run" type="submit" disabled={isRpmRunning || isBoundaryRunning || isEndpointRunning || profileBusy || !modelsToEnqueue.length} className="h-10 gap-2 bg-[#f3a712] text-[#172033] hover:bg-[#e99a02]"><Play className="size-4" />{isRunning ? `Add to queue (${modelsToEnqueue.length})` : selectedModels.length ? `Test selected models (${selectedModels.length})` : 'Run 12-question check'}</Button>}
              {testMode === 'normal' && ['running', 'queued', 'stopping'].includes(liveNormalPhase) && <Button key="normal-stop" type="button" variant="outline" className="h-10" onClick={stopNormalTest} disabled={liveNormalPhase === 'stopping'}>{liveNormalPhase === 'stopping' ? 'Stopping…' : 'Stop selected model'}</Button>}
            </div>
            {testMode === 'normal' && apiType === 'openai' && isOpenRouter(baseUrl) && model.startsWith('openai/') && <div className="space-y-2 rounded-xl border border-border p-3">
              <label className="block text-sm font-medium">OpenRouter resource<select aria-label="OpenRouter resource" className="ml-3 rounded-lg border border-input bg-background p-2" value={openRouterTier} onChange={event => setOpenRouterTier(event.target.value as OpenRouterTier)}><option value="default">OpenAI · Standard</option><option value="flex">OpenAI · Flex (discounted)</option></select></label>
              <p className="text-sm text-muted-foreground">Pins the selected resource with fallback disabled. Each route uses the same 12 questions, low reasoning, a 512-token cap and a 120-second timeout per question. Actual tier and reported cost appear in request details. Flex availability and pricing depend on the model.</p>
            </div>}
            {!selectedProfileId && <details><summary className="cursor-pointer text-sm font-medium text-primary">One-time connection details</summary><div className="mt-3 grid gap-4 md:grid-cols-3">
              <label className="text-sm font-medium">Base URL<Input className="mt-2 h-10" value={baseUrl} onChange={event => updateConnection({ baseUrl: event.target.value })} disabled={controlsLocked} placeholder="https://your-provider.com/v1" /></label>
              <label className="text-sm font-medium">API key<Input className="mt-2 h-10" type="password" autoComplete="off" value={apiKey} onChange={event => updateApiKey(event.target.value)} disabled={controlsLocked} placeholder="Enter your key for this test" /></label>
              <label className="text-sm font-medium">History name (optional)<Input className="mt-2 h-10" value={profileName} onChange={event => setProfileName(event.target.value)} disabled={controlsLocked} /></label>
            </div><p className="mt-3 text-sm text-muted-foreground">One-time keys are not saved. Use Connections to save an encrypted key for every test.</p></details>}
            {testMode === 'normal' && <details><summary className="cursor-pointer text-sm font-medium">Multiple models and parallel requests</summary><div className="mt-3">              {testMode === 'normal' ? (
                <fieldset
                  disabled={
                    isRpmRunning ||
                    isBoundaryRunning ||
                    isEndpointRunning ||
                    profileBusy
                  }
                  className="space-y-3 rounded-xl border border-blue-200 bg-blue-50/50 p-3"
                >
                  <legend className="px-1 text-sm font-semibold">
                    Test multiple models
                  </legend>
                  <div className="flex flex-wrap gap-3 text-sm">
                    <button
                      type="button"
                      className="font-medium text-primary underline"
                      onClick={() => setSelectedModels(modelChoices)}
                    >
                      Select all
                    </button>
                    <button
                      type="button"
                      className="text-muted-foreground underline"
                      onClick={() => setSelectedModels([])}
                    >
                      Clear selection
                    </button>
                  </div>
                  <div className="flex max-h-56 flex-wrap gap-4 overflow-y-auto">
                    {modelChoices.map((name) => (
                      <label
                        key={name}
                        className="flex items-start gap-2 break-all text-sm"
                      >
                        <input
                          type="checkbox"
                          className="mt-1 size-4 shrink-0 accent-primary"
                          checked={selectedModels.includes(name)}
                          onChange={(event) =>
                            setSelectedModels((current) =>
                              event.target.checked
                                ? [...new Set([...current, name])]
                                : current.filter((item) => item !== name),
                            )
                          }
                        />
                        <span className="font-mono">{name}</span>
                      </label>
                    ))}
                  </div>
                  <label className="flex items-center justify-between gap-2 text-sm">
                    Parallel models
                    <select
                      value={concurrency}
                      onChange={(event) => {
                        const value = Number(event.target.value);
                        setConcurrency(value);
                        normalQueue.setConcurrency(value);
                      }}
                      className="h-9 rounded-lg border border-input bg-card px-3"
                    >
                      {[1, 2, 3, 4, 5, 6].map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="text-xs leading-5 text-muted-foreground">
                    {modelsToEnqueue.length} model
                    {modelsToEnqueue.length === 1 ? '' : 's'} · up to{' '}
                    {modelsToEnqueue.length * 12} paid requests.{' '}
                    {selectedModels.length ? '' : 'Using the current model. '}
                    Each model runs 12 questions sequentially. Models share your
                    connection’s rate limits.
                  </p>
                  {isRunning ? (
                    <p className="text-xs leading-5 text-blue-950">
                      Select more models or add a name above, then add them to
                      the queue. Existing tests keep their original settings.
                    </p>
                  ) : null}
                </fieldset>
              ) : null}
</div></details>}
            {profileMessage && <p role="status" className="text-sm text-muted-foreground">{profileMessage}</p>}
            {formError && <p role="alert" className="text-sm text-destructive">{formError}</p>}
          </form>

          <div className="min-w-0 space-y-5">
            {controlsLocked ||
            (lastRunMode &&
              (viewMode !== 'current' || testMode !== lastRunMode)) ? (
              <div
                className="sticky top-2 z-20 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-blue-200 bg-blue-50 p-3 shadow-sm"
                data-testid="active-test-notice"
              >
                <div className="min-w-0 text-xs text-blue-950">
                  <output className="block font-semibold">
                    {isRunning
                      ? `Model tests active · ${queueJobs.filter((job) => job.phase === 'running').length} running · ${queueJobs.filter((job) => job.phase === 'queued').length} queued · ${queueJobs.filter((job) => job.phase === 'saving').length} saving · ${queueJobs.filter((job) => job.phase === 'complete').length} completed`
                      : isRpmRunning
                        ? `RPM test running${rpmMessage ? ` · ${rpmMessage}` : ''}`
                        : isBoundaryRunning
                          ? 'Tool-boundary probe running'
                          : isEndpointRunning
                            ? 'Three-endpoint comparison running'
                            : `${lastRunMode === 'rpm' ? 'RPM test' : lastRunMode === 'boundary' ? 'Tool-boundary probe' : lastRunMode === 'endpoints' ? 'Three-endpoint comparison' : 'Normal check'} is no longer running — results available`}
                  </output>
                  {controlsLocked ? (
                    <p className="mt-1 leading-5">
                      You can browse history and switch views. Keep this browser
                      tab open.{' '}
                      {isRunning
                        ? 'You can change the model and add more to the queue. The connection and API type stay fixed while models are active.'
                        : 'Connection settings stay locked until the test ends.'}
                    </p>
                  ) : null}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    showCurrent(
                      isRunning
                        ? 'normal'
                        : isRpmRunning
                          ? 'rpm'
                          : isBoundaryRunning
                            ? 'boundary'
                            : isEndpointRunning
                              ? 'endpoints'
                              : (lastRunMode ?? testMode),
                    )
                  }
                >
                  {controlsLocked ? 'View live test' : 'View latest results'}
                </Button>
              </div>
            ) : null}
            <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card p-1.5 shadow-sm">
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => showCurrent()}
                  className={`inline-flex h-9 items-center gap-2 rounded-lg px-3 text-xs font-semibold ${viewMode === 'current' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}
                >
                  <Activity className="size-3.5" /> Current results
                </button>
                <button
                  type="button"
                  onClick={showHistory}
                  className={`inline-flex h-9 items-center gap-2 rounded-lg px-3 text-xs font-semibold ${viewMode !== 'current' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}
                >
                  <History className="size-3.5" /> Saved runs{' '}
                  {user ? `(${runs.length})` : ''}
                </button>
              </div>
              {viewMode === 'current' && testMode === 'normal' ? (
                <div className="mr-1 flex items-center gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      if (runContext) exportEvidence(runContext, results);
                    }}
                    disabled={!runContext || completed === 0}
                    className="h-8 gap-1.5 px-2.5 text-[11px]"
                  >
                    <Download className="size-3" /> Export evidence
                  </Button>
                  <button
                    type="button"
                    onClick={resetResults}
                    disabled={controlsLocked}
                    className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                  >
                    <RotateCcw className="size-3" /> Reset
                  </button>
                </div>
              ) : null}
            </div>

            {viewMode === 'current' && testMode === 'normal' ? (
              <ModelTestQueue
                jobs={queueJobs}
                selectedId={liveJob?.id}
                onView={(id) => setSelectedJobId(id)}
                onStop={(id) => normalQueue.stop(id)}
                onStopAll={() => normalQueue.stopAll()}
                onHistory={showJobHistory}
              />
            ) : null}

            {viewMode === 'detail' && savedPreview ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-4">
                <div>
                  <p className="text-sm font-semibold">
                    Saved result ·{' '}
                    {savedPreview.diagnostic
                      ? `${DIAGNOSTIC_LABELS[savedPreview.diagnostic.testKind]} · `
                      : ''}
                    {savedPreview.run.profileName ?? 'One-time connection'}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {savedPreview.run.modelName} · {savedPreview.run.apiType} ·{' '}
                    {new Date(savedPreview.run.createdAt).toLocaleString()}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={showHistory}
                  >
                    Back to saved runs
                  </Button>
                  {normalPreview && runContext ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => exportEvidence(runContext, results)}
                    >
                      <Download className="mr-1 size-3" />
                      Export saved evidence
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}

            {user && <EvidenceReviewPanel runs={runs} />}
            {viewMode === 'saved' ? (
              <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-[0_18px_50px_rgb(15_23_42/0.06)]">
                <div className="border-b border-border px-5 py-4">
                  <h2 className="text-sm font-semibold">Private saved runs</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {user && runs.length
                      ? `Showing ${filteredRuns.length} of ${runs.length} saved runs.`
                      : 'Completed tests are saved automatically when you are signed in.'}
                  </p>
                  {hasSavedRunFilters ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-2"
                      onClick={() => {
                        setSavedConnectionFilter('');
                        setSavedModelFilter('');
                        setSavedApiTypeFilter('');
                        setSavedTestTypeFilter('');
                      }}
                    >
                      Show all saved runs
                    </Button>
                  ) : null}
                  {user && runs.length ? (
                    <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      <label className="grid gap-1.5 text-xs font-medium text-foreground">
                        Test type
                        <select
                          value={savedTestTypeFilter}
                          onChange={(event) =>
                            setSavedTestTypeFilter(
                              event.target.value as '' | TestMode,
                            )
                          }
                          className="h-10 min-w-0 rounded-lg border border-input bg-background px-3 text-sm font-normal shadow-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
                        >
                          <option value="">All tests</option>
                          <option value="normal">Normal token</option>
                          <option value="rpm">RPM ramp</option>
                          <option value="boundary">Tool Boundary Probe</option>
                          <option value="endpoints">Three Endpoints</option>
                        </select>
                      </label>
                      <label className="grid gap-1.5 text-xs font-medium text-foreground">
                        Connection name
                        <select
                          value={savedConnectionFilter}
                          onChange={(event) =>
                            setSavedConnectionFilter(event.target.value)
                          }
                          className="h-10 min-w-0 rounded-lg border border-input bg-background px-3 text-sm font-normal shadow-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
                        >
                          <option value="">All connections</option>
                          {savedConnectionNames.map((name) => (
                            <option key={name} value={name}>
                              {name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="grid gap-1.5 text-xs font-medium text-foreground">
                        API type
                        <select
                          value={savedApiTypeFilter}
                          onChange={(event) =>
                            setSavedApiTypeFilter(
                              event.target.value as '' | ApiType,
                            )
                          }
                          className="h-10 min-w-0 rounded-lg border border-input bg-background px-3 text-sm font-normal shadow-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
                        >
                          <option value="">All API types</option>
                          <option value="anthropic">Anthropic</option>
                          <option value="openai">OpenAI</option>
                        </select>
                      </label>
                      <label className="grid gap-1.5 text-xs font-medium text-foreground">
                        Model name
                        <select
                          value={savedModelFilter}
                          onChange={(event) =>
                            setSavedModelFilter(event.target.value)
                          }
                          className="h-10 min-w-0 rounded-lg border border-input bg-background px-3 font-mono text-sm font-normal shadow-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
                        >
                          <option value="">All models</option>
                          {savedModelNames.map((name) => (
                            <option key={name} value={name}>
                              {name}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  ) : null}
                </div>
                {!user ? (
                  <div className="grid min-h-72 place-items-center p-8 text-center">
                    <div>
                      <LockKeyhole className="mx-auto size-8 text-muted-foreground" />
                      <p className="mt-3 text-sm font-semibold">
                        Sign in to view saved runs
                      </p>
                      <a
                        href={signInPath}
                        target="_top"
                        className="mt-3 inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground"
                      >
                        <LogIn className="size-4" /> Sign in with Google
                      </a>
                    </div>
                  </div>
                ) : !runs.length ? (
                  <div className="grid min-h-72 place-items-center p-8 text-center text-sm text-muted-foreground">
                    Your completed runs will appear here.
                  </div>
                ) : !filteredRuns.length ? (
                  <div className="grid min-h-72 place-items-center p-8 text-center">
                    <div>
                      <p className="text-sm font-semibold">
                        No saved runs match these filters
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Choose a different connection, API type, or model.
                      </p>
                      {hasSavedRunFilters ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="mt-4"
                          onClick={() => {
                            setSavedConnectionFilter('');
                            setSavedModelFilter('');
                            setSavedApiTypeFilter('');
                            setSavedTestTypeFilter('');
                          }}
                        >
                          Clear filters
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <div className="divide-y divide-border">
                    {filteredRuns.map((run) => {
                      const runVerdict =
                        run.testKind === 'rpm' ? savedRpmVerdict(run) : null;
                      return (
                        <div
                          key={run.id}
                          className="flex flex-wrap items-center gap-4 px-5 py-4 hover:bg-muted/35"
                        >
                          <button
                            type="button"
                            onClick={() => void openRun(run)}
                            disabled={historyBusy}
                            className="min-w-0 flex-1 text-left"
                          >
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-semibold">
                                {run.profileName ?? 'One-time connection'}
                              </span>
                              <Badge
                                variant="outline"
                                className={
                                  run.testKind === 'rpm'
                                    ? 'border-cyan-200 bg-cyan-50 text-cyan-800'
                                    : 'border-slate-200 bg-slate-50 text-slate-700'
                                }
                              >
                                {run.testKind === 'rpm'
                                  ? 'RPM ramp'
                                  : run.testKind === 'normal'
                                    ? 'Normal token'
                                    : DIAGNOSTIC_LABELS[run.testKind]}
                              </Badge>
                              <Badge
                                variant="outline"
                                className={
                                  run.apiType === 'anthropic'
                                    ? 'border-violet-200 bg-violet-50 text-violet-800'
                                    : 'border-blue-200 bg-blue-50 text-blue-800'
                                }
                              >
                                {run.apiType === 'anthropic'
                                  ? 'Anthropic'
                                  : 'OpenAI'}
                              </Badge>
                              {runVerdict ? (
                                <Badge
                                  variant="outline"
                                  className={runVerdict.className}
                                >
                                  {runVerdict.label}
                                </Badge>
                              ) : null}
                            </div>
                            <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                              {run.modelName} · {run.baseUrl}
                            </p>
                            {run.testKind === 'rpm' ? (
                              <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                                Target {run.targetRpm.toLocaleString()} RPM ·{' '}
                                Sent {run.totalAttempted.toLocaleString()} ·
                                Successful responses{' '}
                                {run.totalSucceeded.toLocaleString()} · 429{' '}
                                {run.totalRateLimited.toLocaleString()} ·
                                Worst-stage P95{' '}
                                {durationOrDash(run.p95LatencyMs)}
                              </p>
                            ) : run.testKind !== 'normal' ? (
                              <p className="mt-1 text-xs text-muted-foreground">
                                {run.status === 'stopped'
                                  ? 'Stopped'
                                  : run.status === 'issues'
                                    ? 'Finished with issues'
                                    : 'Completed'}{' '}
                                · {run.capturedCount} / {run.totalCount}{' '}
                                responses captured · {run.issueCount} issues
                                {run.testKind === 'boundary'
                                  ? ` · ${run.reviewedCount} / ${run.totalCount} reviewed`
                                  : ''}
                              </p>
                            ) : (
                              <>
                                <NormalOutcomeCounts source={run} />
                                <p className="mt-2 text-xs text-muted-foreground">
                                  {normalOutcomes(run).finished} /{' '}
                                  {NORMAL_QUESTIONS.length} requests finished
                                </p>
                                <p className="mt-1 font-mono text-xs text-muted-foreground">
                                  Median TTFT {durationOrDash(run.medianTtftMs)}{' '}
                                  · Median total{' '}
                                  {durationOrDash(run.medianTotalTimeMs)} ·{' '}
                                  Median output{' '}
                                  {rateOrDash(run.medianOutputTokensPerSecond)}
                                </p>
                              </>
                            )}
                            <p className="mt-1 inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                              <Clock3 className="size-3" />{' '}
                              {new Date(run.createdAt).toLocaleString()}
                            </p>
                          </button>
                          <button
                            type="button"
                            onClick={() => void exportSavedRun(run)}
                            disabled={historyBusy}
                            className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-blue-50 hover:text-blue-700"
                            aria-label="Export saved run evidence"
                            title={
                              run.testKind !== 'normal'
                                ? 'Export full JSON evidence'
                                : 'Export evidence ZIP'
                            }
                          >
                            <Download className="size-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void deleteRun(run)}
                            disabled={
                              historyBusy ||
                              (run.testKind === 'rpm' &&
                                ['preflight', 'ready', 'running'].includes(
                                  run.status,
                                ))
                            }
                            className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-rose-50 hover:text-rose-700"
                            aria-label="Delete saved run"
                          >
                            <Trash2 className="size-4" />
                          </button>
                          <ChevronRight className="size-4 text-muted-foreground" />
                          {run.testKind === 'normal' &&
                          !run.profileId &&
                          !run.profileName ? (
                            <AssignRunConnection
                              run={run}
                              profiles={profiles}
                              onAssigned={onHistoryAssigned}
                            />
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            ) : normalPreview ||
              (viewMode === 'current' && testMode === 'normal') ? (
              <>
                <div className="grid gap-5 lg:grid-cols-2">
                  <section
                    className={`rounded-2xl border p-5 shadow-[0_18px_50px_rgb(15_23_42/0.05)] ${overall.tone === 'warning' ? 'border-amber-200 bg-amber-50/70' : 'border-border bg-card'}`}
                  >
                    <output className="sr-only" aria-live="polite">
                      {overall.title}. {overall.description}
                    </output>
                    <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                      Token check results
                    </p>
                    <h2 className="mt-1 text-xl font-semibold tracking-tight">
                      {overall.title}
                    </h2>
                    <p className="mt-1 min-h-12 text-sm leading-6 text-muted-foreground">
                      {overall.description}
                    </p>
                    <NormalOutcomeCounts source={outcomeSource} tiles />
                    {['running', 'stopping', 'saving'].includes(normalPhase) ||
                    !completed ? (
                      <Progress
                        value={progress}
                        className="mt-4 [&_[data-slot=progress-indicator]]:bg-[#39a987]"
                        aria-label={`${progress}% complete`}
                        aria-valuetext={`${completed} of 12 questions finished`}
                      />
                    ) : (
                      <div
                        aria-hidden="true"
                        className="mt-4 flex h-1.5 overflow-hidden rounded-full bg-muted"
                      >
                        {[
                          { count: normalCount + cacheCount, color: 'bg-emerald-500' },
                          {
                            count: largeCount,
                            color: 'bg-amber-500',
                          },
                          { count: errorCount, color: 'bg-rose-500' },
                          { count: unavailableCount, color: 'bg-slate-400' },
                        ].map((segment) => (
                          <span
                            key={segment.color}
                            className={segment.color}
                            style={{
                              width: `${(segment.count / NORMAL_QUESTIONS.length) * 100}%`,
                            }}
                          />
                        ))}
                      </div>
                    )}
                  </section>

                  <section className="rounded-2xl border border-blue-200 bg-blue-50/55 p-5 shadow-[0_18px_50px_rgb(15_23_42/0.05)]">
                    <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                      Performance
                    </p>
                    <h2 className="mt-1 text-xl font-semibold tracking-tight">
                      {performanceSummary.measuredCount
                        ? `Median TTFT ${durationOrDash(performanceSummary.medianTtftMs)}`
                        : normalPhase === 'running' ||
                            normalPhase === 'stopping'
                          ? 'Waiting for the first streamed token'
                          : 'No timing data yet'}
                    </h2>
                    <p className="mt-1 min-h-12 text-sm leading-6 text-muted-foreground">
                      Measured from this tester&apos;s relay to the provider
                      stream. DNS, TCP, and TLS are intentionally excluded. Each
                      median uses the available timings for that metric. Delivery rate is hidden for short answers or a single burst, and is not internal model decoding speed.
                    </p>
                    <div className="mt-4 grid grid-cols-2 gap-2 text-center sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
                      <div className="rounded-xl border border-blue-200/80 bg-white/70 px-2 py-2.5">
                        <div className="font-mono text-sm font-semibold">
                          {durationOrDash(performanceSummary.medianTtftMs)}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          Median TTFT
                        </div>
                      </div>
                      <div className="rounded-xl border border-blue-200/80 bg-white/70 px-2 py-2.5">
                        <div className="font-mono text-sm font-semibold">
                          {durationOrDash(
                            performanceSummary.medianGenerationMs,
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          Text delivery span
                        </div>
                      </div>
                      <div className="rounded-xl border border-blue-200/80 bg-white/70 px-2 py-2.5">
                        <div className="font-mono text-sm font-semibold">
                          {durationOrDash(performanceSummary.medianTotalTimeMs)}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          Median total
                        </div>
                      </div>
                      <div className="rounded-xl border border-blue-200/80 bg-white/70 px-2 py-2.5">
                        <div className="font-mono text-sm font-semibold">
                          {rateOrDash(
                            performanceSummary.medianOutputTokensPerSecond,
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          Observed delivery rate
                        </div>
                      </div>
                    </div>
                  </section>
                </div>

                <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-[0_18px_50px_rgb(15_23_42/0.06)]">
                  <div className="flex flex-col gap-3 border-b border-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <h2 className="text-sm font-semibold">
                        Question-by-question results
                      </h2>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {runMessage}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        variant="outline"
                        className="bg-background text-[10px]"
                      >
                        {shownApiType === 'anthropic'
                          ? 'Anthropic Messages'
                          : 'OpenAI Chat Completions'}
                      </Badge>
                      <div className="flex rounded-lg bg-muted p-1">
                        <button
                          type="button"
                          onClick={() => setResultsView('tokens')}
                          className={`h-8 rounded-md px-3 text-[11px] font-semibold ${resultsView === 'tokens' ? 'bg-white text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                        >
                          Token usage
                        </button>
                        <button
                          type="button"
                          onClick={() => setResultsView('performance')}
                          className={`h-8 rounded-md px-3 text-[11px] font-semibold ${resultsView === 'performance' ? 'bg-white text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                        >
                          Performance
                        </button>
                      </div>
                    </div>
                  </div>
                  <div className="border-b border-border/70 bg-slate-50/60 px-5 py-3 font-mono text-[10px] leading-5 text-muted-foreground">
                    <p>
                      REQUEST · POST · model=
                      {runContext?.modelName || model.trim() || '—'} ·
                      max_tokens={(() => { try { return JSON.parse(results.find(result => result.requestBody)?.requestBody || '{}').max_tokens ?? 96; } catch { return 96; } })()} · stream=true
                      {shownApiType === 'openai'
                        ? ' · stream_options.include_usage=true'
                        : ''}
                    </p>
                    <p>
                      OMITTED · system · tools · explicit cache settings ·
                      temperature · top_p · top_k
                    </p>
                  </div>
                  {resultsView === 'tokens' ? (
                    <>
                      <div className="border-b border-border/70 px-5 py-2 font-mono text-[10px] text-muted-foreground">
                        {shownApiType === 'anthropic'
                          ? 'TOTAL INPUT = DIRECT + CACHE WRITE + CACHE READ'
                          : 'TOTAL INPUT = DIRECT + CACHED PROMPT · CACHE WRITE N/A'}
                      </div>
                      <Table>
                        <TableHeader>
                          <TableRow className="bg-muted/45 hover:bg-muted/45">
                            <TableHead className="min-w-[360px] pl-5">
                              Question
                            </TableHead>
                            <TableHead className="text-right">Direct</TableHead>
                            <TableHead className="text-right">
                              Cache write
                            </TableHead>
                            <TableHead className="text-right">
                              {shownApiType === 'anthropic'
                                ? 'Cache read'
                                : 'Cached prompt'}
                            </TableHead>
                            <TableHead className="text-right">
                              Total input
                            </TableHead>
                            <TableHead className="text-right">Output</TableHead>
                            <TableHead className="pr-5 text-right">
                              Verdict
                            </TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {results.map((result, index) => {
                            const itemVerdict = verdict(result.status);
                            const VerdictIcon = itemVerdict.icon;
                            return (
                              <TableRow
                                key={`${result.id}-${index}`}
                                className={
                                  result.status === 'running'
                                    ? 'bg-blue-50/60'
                                    : undefined
                                }
                              >
                                <TableCell className="max-w-[560px] whitespace-normal py-4 pl-5 align-top">
                                  <div className="flex items-start gap-3">
                                    <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-muted font-mono text-[10px] text-muted-foreground">
                                      {String(index + 1).padStart(2, '0')}
                                    </span>
                                    <div className="min-w-0">
                                      <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
                                        {result.category}
                                      </div>
                                      <p className="text-sm leading-5">
                                        {result.prompt}
                                      </p>
                                      <RequestResponseDetails result={result} />
                                    </div>
                                  </div>
                                </TableCell>
                                <TableCell className="text-right align-top font-mono text-xs">
                                  {numberOrDash(result.inputTokens)}
                                </TableCell>
                                <TableCell className="text-right align-top font-mono text-xs">
                                  {numberOrDash(
                                    result.cacheCreationInputTokens,
                                  )}
                                </TableCell>
                                <TableCell className="text-right align-top font-mono text-xs">
                                  {numberOrDash(result.cacheReadInputTokens)}
                                </TableCell>
                                <TableCell
                                  className={`text-right align-top font-mono text-xs font-semibold ${result.status === 'large' ? 'text-rose-700' : ''}`}
                                >
                                  {numberOrDash(result.totalInputTokens)}
                                </TableCell>
                                <TableCell className="text-right align-top font-mono text-xs">
                                  {numberOrDash(result.outputTokens)}
                                </TableCell>
                                <TableCell className="pr-5 text-right align-top">
                                  <Badge
                                    variant="outline"
                                    className={`gap-1 ${itemVerdict.className}`}
                                  >
                                    <VerdictIcon
                                      className={
                                        result.status === 'running'
                                          ? 'animate-pulse motion-reduce:animate-none'
                                          : ''
                                      }
                                    />
                                    {itemVerdict.label}
                                  </Badge>
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </>
                  ) : (
                    <>
                      <div className="border-b border-border/70 px-5 py-2 text-[10px] text-muted-foreground">
                        TTFT is time to first visible text. Generation is first
                        visible text to stream completion.
                      </div>
                      <Table>
                        <TableHeader>
                          <TableRow className="bg-muted/45 hover:bg-muted/45">
                            <TableHead className="min-w-[360px] pl-5">
                              Question
                            </TableHead>
                            <TableHead className="text-right">TTFT</TableHead>
                            <TableHead className="text-right">
                              Generation
                            </TableHead>
                            <TableHead className="text-right">Total</TableHead>
                            <TableHead className="text-right">
                              Output speed
                            </TableHead>
                            <TableHead className="text-right">HTTP</TableHead>
                            <TableHead className="pr-5 text-right">
                              Timing
                            </TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {results.map((result, index) => {
                            const hasTiming = typeof result.ttftMs === 'number';
                            const isPending =
                              result.status === 'waiting' ||
                              result.status === 'running';
                            return (
                              <TableRow
                                key={`${result.id}-${index}`}
                                className={
                                  result.status === 'running'
                                    ? 'bg-blue-50/60'
                                    : undefined
                                }
                              >
                                <TableCell className="max-w-[560px] whitespace-normal py-4 pl-5 align-top">
                                  <div className="flex items-start gap-3">
                                    <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-muted font-mono text-[10px] text-muted-foreground">
                                      {String(index + 1).padStart(2, '0')}
                                    </span>
                                    <div className="min-w-0">
                                      <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
                                        {result.category}
                                      </div>
                                      <p className="text-sm leading-5">
                                        {result.prompt}
                                      </p>
                                      <RequestResponseDetails result={result} />
                                    </div>
                                  </div>
                                </TableCell>
                                <TableCell className="text-right align-top font-mono text-xs font-semibold">
                                  {durationOrDash(result.ttftMs)}
                                </TableCell>
                                <TableCell className="text-right align-top font-mono text-xs">
                                  {durationOrDash(result.generationMs)}
                                </TableCell>
                                <TableCell className="text-right align-top font-mono text-xs">
                                  {durationOrDash(result.totalTimeMs)}
                                </TableCell>
                                <TableCell className="text-right align-top font-mono text-xs">
                                  {rateOrDash(result.outputTokensPerSecond)}
                                </TableCell>
                                <TableCell className="text-right align-top font-mono text-xs">
                                  {numberOrDash(result.httpStatus)}
                                </TableCell>
                                <TableCell className="pr-5 text-right align-top">
                                  <Badge
                                    variant="outline"
                                    className={
                                      hasTiming
                                        ? 'border-blue-200 bg-blue-50 text-blue-800'
                                        : isPending
                                          ? 'border-slate-200 bg-slate-50 text-slate-600'
                                          : 'border-amber-200 bg-amber-50 text-amber-900'
                                    }
                                  >
                                    {hasTiming
                                      ? 'Recorded'
                                      : result.status === 'running'
                                        ? 'Measuring'
                                        : result.status === 'waiting'
                                          ? 'Waiting'
                                          : result.status === 'stopped'
                                            ? 'Stopped'
                                            : 'Unavailable'}
                                  </Badge>
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </>
                  )}
                </section>
                <p className="px-1 pb-4 text-xs leading-5 text-muted-foreground">
                  A clean run means no large anomaly was detected in these
                  twelve requests. Routing can change over time, so one clean
                  run cannot prove permanent zero injection.
                </p>
              </>
            ) : null}

            {viewMode === 'detail' && savedPreview?.run.testKind === 'rpm' ? (
              <RpmRampTest
                key={savedPreview.run.id}
                user={user}
                signInPath={signInPath}
                selectedProfileId=""
                profileName={savedPreview.run.profileName}
                apiType={savedPreview.run.apiType}
                baseUrl={savedPreview.run.baseUrl}
                model={savedPreview.run.modelName}
                profileDirty={false}
                openedRunId={savedPreview.run.id}
                readOnly
              />
            ) : null}

            {viewMode === 'detail' && savedPreview?.diagnostic ? (
              savedPreview.diagnostic.testKind === 'endpoints' ? (
                <EndpointCheck
                  key={`saved-${savedPreview.run.id}`}
                  savedRun={savedPreview.diagnostic}
                  apiType={savedPreview.run.apiType}
                  baseUrl={savedPreview.run.baseUrl}
                  model={savedPreview.run.modelName}
                  apiKey=""
                  selectedProfileId=""
                  profileName={savedPreview.run.profileName || ''}
                  profileDirty={false}
                  startBlocked
                  onRunningChange={() => {}}
                />
              ) : (
                <ToolBoundaryTest
                  key={`saved-${savedPreview.run.id}`}
                  savedRun={savedPreview.diagnostic}
                  apiType={savedPreview.run.apiType}
                  baseUrl={savedPreview.run.baseUrl}
                  model={savedPreview.run.modelName}
                  apiKey=""
                  selectedProfileId=""
                  profileName={savedPreview.run.profileName || ''}
                  profileDirty={false}
                  startBlocked
                  onRunningChange={() => {}}
                />
              )
            ) : null}

            <div hidden={viewMode !== 'current' || testMode !== 'endpoints'}>
              <EndpointCheck
                signedIn={Boolean(user)}
                onSaved={upsertDiagnosticRun}
                apiType={apiType}
                baseUrl={baseUrl}
                model={model}
                apiKey={apiKey}
                selectedProfileId={selectedProfileId}
                profileName={selectedProfile?.name || profileName}
                profileDirty={profileDirty}
                startBlocked={
                  isRunning || isRpmRunning || isBoundaryRunning || profileBusy
                }
                onRunningChange={(running) => {
                  setIsEndpointRunning(running);
                  if (running) setLastRunMode('endpoints');
                }}
              />
            </div>

            <div hidden={viewMode !== 'current' || testMode !== 'boundary'}>
              <ToolBoundaryTest
                signedIn={Boolean(user)}
                onSaved={upsertDiagnosticRun}
                apiType={apiType}
                baseUrl={baseUrl}
                model={model}
                apiKey={apiKey}
                selectedProfileId={selectedProfileId}
                profileName={selectedProfile?.name || profileName}
                profileDirty={profileDirty}
                startBlocked={
                  isRunning || isRpmRunning || isEndpointRunning || profileBusy
                }
                onRunningChange={(running) => {
                  setIsBoundaryRunning(running);
                  if (running) setLastRunMode('boundary');
                }}
              />
            </div>

            {/* Keep the live runner and its progress connections mounted across navigation. */}
            <div
              hidden={viewMode !== 'current' || testMode !== 'rpm'}
              data-testid="live-rpm-panel"
            >
              <RpmRampTest
                user={user}
                signInPath={signInPath}
                selectedProfileId={selectedProfileId}
                profileName={selectedProfile?.name ?? profileName ?? null}
                apiType={apiType}
                baseUrl={baseUrl}
                model={model}
                profileDirty={profileDirty}
                openedRunId=""
                startBlocked={
                  isRunning ||
                  isBoundaryRunning ||
                  isEndpointRunning ||
                  profileBusy
                }
                discoverActiveRun={testMode === 'rpm'}
                onRunningChange={onRpmRunningChange}
                onProgressChange={setRpmMessage}
                onRunSaved={upsertRpmRun}
              />
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
