'use client';
/* oxlint-disable react/react-compiler */

import { useEffect, useMemo, useRef, useState } from 'react';
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
  History,
  KeyRound,
  LockKeyhole,
  LogIn,
  Play,
  Plus,
  RotateCcw,
  Save,
  ShieldCheck,
  Square,
  Trash2,
  UserRound,
  X,
  XCircle,
} from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
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

type ApiType = 'anthropic' | 'openai';
type ResultStatus =
  | 'waiting'
  | 'running'
  | 'normal'
  | 'cached'
  | 'large'
  | 'unavailable'
  | 'error';
type ViewMode = 'current' | 'saved';
type ResultsView = 'tokens' | 'performance';

type ConnectionSettings = { baseUrl: string; model: string };
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

type Profile = {
  id: string;
  name: string;
  apiType: ApiType;
  baseUrl: string;
  models: string[];
  hasSavedKey: boolean;
  createdAt: number;
  updatedAt: number;
};

type RunSummary = {
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
const SETTINGS_KEY = 'normal-token-check:connection:v3';
const OLD_SETTINGS_KEY = 'normal-token-check:connection:v2';
const LEGACY_SETTINGS_KEY = 'normal-token-check:connection:v1';

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
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:')
      return 'Only public HTTPS base URLs are supported.';
    if (url.search) return 'The base URL cannot contain query parameters.';
    return '';
  } catch {
    return 'Enter a valid base URL.';
  }
}

function classifyResult(result: ApiResponse): ResultStatus {
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
      label: 'Cache found',
      icon: AlertTriangle,
      className: 'border-amber-200 bg-amber-50 text-amber-900',
    };
  if (status === 'large')
    return {
      label: 'Large context',
      icon: AlertTriangle,
      className: 'border-rose-200 bg-rose-50 text-rose-800',
    };
  if (status === 'unavailable')
    return {
      label: 'Usage unavailable',
      icon: AlertTriangle,
      className: 'border-slate-200 bg-slate-50 text-slate-700',
    };
  if (status === 'error')
    return {
      label: 'Failed',
      icon: XCircle,
      className: 'border-rose-200 bg-rose-50 text-rose-800',
    };
  return {
    label: status === 'running' ? 'Testing' : 'Waiting',
    icon: Activity,
    className: 'border-slate-200 bg-slate-50 text-slate-600',
  };
}

function savedVerdict(run: RunSummary) {
  if (run.largeCount)
    return {
      label: run.errorCount
        ? `Large context · ${run.errorCount} failed`
        : 'Large context',
      className: 'border-rose-200 bg-rose-50 text-rose-800',
    };
  if (run.cacheCount)
    return {
      label: 'Cache found',
      className: 'border-amber-200 bg-amber-50 text-amber-900',
    };
  if (run.errorCount)
    return {
      label: 'Incomplete',
      className: 'border-rose-200 bg-rose-50 text-rose-800',
    };
  if (run.unavailableCount)
    return {
      label: 'Usage unavailable',
      className: 'border-slate-200 bg-slate-50 text-slate-700',
    };
  return {
    label: 'No large anomaly',
    className: 'border-emerald-200 bg-emerald-50 text-emerald-800',
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
  const data = (await response.json()) as ApiResponse;
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

        {hasRequest ? (
          <details>
            <summary className="cursor-pointer font-semibold text-foreground">
              Exact request
            </summary>
            <div className="mt-2 space-y-2">
              <p className="break-all font-mono text-[10px] text-foreground">
                {result.requestMethod || 'POST'} {result.requestUrl}
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
  return {
    ...context,
    verdict: largeCount
      ? 'large'
      : cacheCount
        ? 'cached'
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
  signOutPath,
}: {
  signInPath: string;
  signOutPath: string;
}) {
  const [user, setUser] = useState<User>(null);
  const [apiType, setApiType] = useState<ApiType>('anthropic');
  const [shownApiType, setShownApiType] = useState<ApiType>('anthropic');
  const [connections, setConnections] =
    useState<Record<ApiType, ConnectionSettings>>(DEFAULT_CONNECTIONS);
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [settingsReady, setSettingsReady] = useState(false);
  const [results, setResults] = useState<TestResult[]>(initialResults);
  const [isRunning, setIsRunning] = useState(false);
  const [formError, setFormError] = useState('');
  const [runMessage, setRunMessage] = useState(
    'Ready for a new 12-question check.',
  );
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [profileName, setProfileName] = useState('');
  const [profileModels, setProfileModels] = useState<string[]>([]);
  const [newModel, setNewModel] = useState('');
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileDirty, setProfileDirty] = useState(false);
  const [profileMessage, setProfileMessage] = useState('');
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>('current');
  const [resultsView, setResultsView] = useState<ResultsView>('tokens');
  const [runContext, setRunContext] = useState<RunContext | null>(null);
  const [selectedRunId, setSelectedRunId] = useState('');
  const [historyBusy, setHistoryBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const { baseUrl, model } = connections[apiType];
  const selectedProfile =
    profiles.find((profile) => profile.id === selectedProfileId) ?? null;

  function updateConnection(
    patch: Partial<ConnectionSettings>,
    forType = apiType,
  ) {
    setConnections((current) => ({
      ...current,
      [forType]: { ...current[forType], ...patch },
    }));
  }

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(SETTINGS_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as {
          apiType?: ApiType;
          connections?: Partial<Record<ApiType, Partial<ConnectionSettings>>>;
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
      } else {
        const old = window.localStorage.getItem(OLD_SETTINGS_KEY);
        const legacy = window.localStorage.getItem(LEGACY_SETTINGS_KEY);
        if (old) {
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
          setConnections({
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
          });
        } else if (legacy) {
          const parsed = JSON.parse(legacy) as {
            endpoint?: string;
            model?: string;
          };
          setConnections((current) => ({
            ...current,
            anthropic: {
              baseUrl: stripEndpoint(
                parsed.endpoint ?? current.anthropic.baseUrl,
                'anthropic',
              ),
              model: parsed.model ?? current.anthropic.model,
            },
          }));
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
          jsonFetch<{ profiles: Profile[] }>('/api/profiles'),
          jsonFetch<{ runs: RunSummary[] }>('/api/runs'),
        ]).then(([profilesData, runsData]) => {
          setProfiles(profilesData.profiles);
          setRuns(runsData.runs);
        });
      })
      .catch((error: unknown) => {
        setProfileMessage(
          error instanceof Error ? error.message : 'Could not load saved data.',
        );
      });
  }, []);

  useEffect(() => {
    if (!settingsReady) return;
    window.localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ apiType, connections }),
    );
  }, [apiType, connections, settingsReady]);

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
    if (isRunning)
      return {
        tone: 'running',
        title: `Testing question ${Math.min(completed + 1, 12)} of 12`,
        description:
          'Each request uses no system prompt, tools, or explicit cache settings.',
      };
    if (!completed)
      return {
        tone: 'ready',
        title: 'Ready to check',
        description:
          'Normal questions should have small inputs and no unexpected reported cache usage.',
      };
    if (largeCount)
      return {
        tone: 'danger',
        title: errorCount
          ? 'Large hidden context and request failures'
          : 'Large hidden context detected',
        description: `${largeCount} request${largeCount === 1 ? '' : 's'} reported at least 1,000 total input tokens.${errorCount ? ` ${errorCount} request${errorCount === 1 ? '' : 's'} also failed; open the affected rows for the exact error and request.` : ''}`,
      };
    if (cacheCount)
      return {
        tone: 'warning',
        title: 'Unexpected cache activity detected',
        description: `${cacheCount} request${cacheCount === 1 ? '' : 's'} included cached input even though this test did not request caching.`,
      };
    if (errorCount)
      return {
        tone: 'danger',
        title: 'Test incomplete',
        description: `${errorCount} request${errorCount === 1 ? '' : 's'} failed. Check the connection and retry.`,
      };
    if (unavailableCount)
      return {
        tone: 'warning',
        title: 'Token verdict unavailable',
        description: `${unavailableCount} request${unavailableCount === 1 ? '' : 's'} did not return usable token counts, so no token verdict can be made for the full run.`,
      };
    if (completed < 12)
      return {
        tone: 'ready',
        title: 'Run stopped',
        description: `${completed} of 12 questions completed.`,
      };
    return {
      tone: 'success',
      title: 'No large token anomaly detected',
      description: `All ${normalCount} requests used small inputs with no reported cache activity. This is not proof of permanent zero injection.`,
    };
  }, [
    cacheCount,
    completed,
    errorCount,
    isRunning,
    largeCount,
    normalCount,
    unavailableCount,
  ]);

  function chooseType(nextType: ApiType) {
    if (isRunning || nextType === apiType) return;
    setApiType(nextType);
    if (selectedProfileId) setProfileDirty(true);
    else setApiKey('');
    setFormError('');
  }

  function selectProfile(id: string) {
    if (isRunning) return;
    setSelectedProfileId(id);
    setProfileMessage('');
    setProfileDirty(false);
    setApiKey('');
    if (!id) {
      setProfileName('');
      setProfileModels([]);
      return;
    }
    const profile = profiles.find((item) => item.id === id);
    if (!profile) return;
    setProfileName(profile.name);
    setProfileModels(profile.models);
    setApiType(profile.apiType);
    updateConnection(
      { baseUrl: profile.baseUrl, model: profile.models[0] ?? '' },
      profile.apiType,
    );
  }

  function addModel() {
    const next = newModel.trim();
    if (!next || next.length > 120) return;
    setProfileModels((current) => [...new Set([...current, next])]);
    if (selectedProfileId) setProfileDirty(true);
    updateConnection({ model: next });
    setNewModel('');
  }

  function removeModel(item: string) {
    const next = profileModels.filter((modelName) => modelName !== item);
    setProfileModels(next);
    if (selectedProfileId) setProfileDirty(true);
    if (model === item) updateConnection({ model: next[0] ?? '' });
  }

  async function saveProfile() {
    if (!user) return;
    setProfileMessage('');
    setProfileBusy(true);
    const models = [
      ...new Set([...profileModels, model.trim()].filter(Boolean)),
    ];
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
            apiType,
            baseUrl,
            apiKey,
            models,
          }),
        },
      );
      setProfiles((current) => [
        data.profile,
        ...current.filter((item) => item.id !== data.profile.id),
      ]);
      setSelectedProfileId(data.profile.id);
      setProfileModels(data.profile.models);
      setApiKey('');
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
      setProfileModels([]);
      setApiKey('');
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

  function updateResult(index: number, patch: Partial<TestResult>) {
    setResults((current) =>
      current.map((result, resultIndex) =>
        resultIndex === index ? { ...result, ...patch } : result,
      ),
    );
  }

  async function saveCompletedRun(finishedResults: TestResult[]) {
    if (!user) return;
    try {
      const data = await jsonFetch<{ run: RunSummary }>('/api/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          profileId: selectedProfileId || null,
          apiType,
          baseUrl,
          model,
          results: finishedResults,
        }),
      });
      setRuns((current) => [data.run, ...current]);
      setRunContext((current) =>
        current ? { ...current, id: data.run.id } : current,
      );
      setRunMessage('Test complete and saved to your private history.');
    } catch (error) {
      setRunMessage(
        `Test complete, but saving failed: ${error instanceof Error ? error.message : 'try again later.'}`,
      );
    }
  }

  function exportEvidence(context: RunContext, exportedResults: TestResult[]) {
    downloadEvidenceArchive(
      evidenceRun(context, exportedResults),
      exportedResults,
    );
    setRunMessage(
      'Evidence ZIP exported. API keys and cookie values were not included.',
    );
  }

  async function exportSavedRun(run: RunSummary) {
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
    if (isRunning) return;
    setFormError('');
    const baseUrlError = clientBaseUrlError(baseUrl.trim());
    if (baseUrlError) return setFormError(baseUrlError);
    if (!selectedProfileId && !apiKey.trim())
      return setFormError('Enter your API key, or choose a saved profile.');
    if (selectedProfileId && profileDirty)
      return setFormError('Save your profile changes before running the test.');
    if (!model.trim()) return setFormError('Enter or choose a model name.');

    const controller = new AbortController();
    abortRef.current = controller;
    setIsRunning(true);
    setViewMode('current');
    setSelectedRunId('');
    setShownApiType(apiType);
    setRunContext({
      source: 'current',
      profileName: selectedProfile?.name ?? null,
      apiType,
      baseUrl: baseUrl.trim(),
      modelName: model.trim(),
      createdAt: Date.now(),
    });
    setRunMessage('Running ordinary questions one at a time…');
    const finishedResults = initialResults();
    setResults(finishedResults);

    try {
      for (let index = 0; index < NORMAL_QUESTIONS.length; index += 1) {
        if (controller.signal.aborted) break;
        const question = NORMAL_QUESTIONS[index];
        updateResult(index, { status: 'running' });
        try {
          const data = await testFetch({
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              profileId: selectedProfileId || undefined,
              apiType: selectedProfileId ? undefined : apiType,
              baseUrl: selectedProfileId ? undefined : baseUrl,
              apiKey: selectedProfileId ? undefined : apiKey.trim(),
              model: model.trim(),
              prompt: question.prompt,
            }),
            signal: controller.signal,
          });
          finishedResults[index] = {
            ...question,
            ...data,
            status: classifyResult(data),
          };
        } catch (error) {
          if (controller.signal.aborted) break;
          finishedResults[index] = {
            ...question,
            status: 'error',
            error:
              error instanceof Error ? error.message : 'Unknown request error.',
          };
        }
        setResults([...finishedResults]);
      }
      if (controller.signal.aborted) {
        setRunMessage('Test stopped. You can start a fresh run.');
      } else {
        setRunMessage(
          user
            ? 'Test complete. Saving to your private history…'
            : 'Test complete. Sign in next time to save your runs.',
        );
        await saveCompletedRun(finishedResults);
      }
    } finally {
      setIsRunning(false);
      abortRef.current = null;
    }
  }

  async function openRun(run: RunSummary) {
    setHistoryBusy(true);
    try {
      const data = await jsonFetch<{
        run: RunSummary;
        results: Array<TestResult & { questionId: string }>;
      }>(`/api/runs/${run.id}`);
      setResults(
        data.results.map((result) => ({ ...result, id: result.questionId })),
      );
      setShownApiType(data.run.apiType);
      setRunContext({
        id: data.run.id,
        source: 'saved',
        profileName: data.run.profileName,
        apiType: data.run.apiType,
        baseUrl: data.run.baseUrl,
        modelName: data.run.modelName,
        createdAt: data.run.createdAt,
      });
      setSelectedRunId(run.id);
      setRunMessage(
        `Saved run from ${new Date(run.createdAt).toLocaleString()}.`,
      );
      setViewMode('current');
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

  async function deleteRun(id: string) {
    setHistoryBusy(true);
    try {
      await jsonFetch<{ deleted: boolean }>(`/api/runs/${id}`, {
        method: 'DELETE',
      });
      setRuns((current) => current.filter((run) => run.id !== id));
      if (selectedRunId === id) {
        setSelectedRunId('');
        setResults(initialResults());
        setRunContext(null);
        setRunMessage('Saved run deleted.');
      }
    } catch (error) {
      setProfileMessage(
        error instanceof Error ? error.message : 'Could not delete this run.',
      );
    } finally {
      setHistoryBusy(false);
    }
  }

  function resetResults() {
    if (isRunning) return;
    setResults(initialResults());
    setRunContext(null);
    setSelectedRunId('');
    setShownApiType(apiType);
    setRunMessage('Ready for a new 12-question check.');
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
              Normal Token Check
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
              Test ordinary questions through Anthropic Messages or OpenAI Chat
              Completions, then compare the reported token usage.
            </p>
          </div>
          {user ? (
            <div className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
              <UserRound className="size-4" />
              <span className="max-w-48 truncate">{user.displayName}</span>
              <a
                href={signOutPath}
                target="_top"
                className="font-semibold hover:underline"
              >
                Sign out
              </a>
            </div>
          ) : (
            <a
              href={signInPath}
              target="_top"
              className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-border bg-card px-3 text-xs font-semibold shadow-sm hover:bg-muted"
            >
              <LogIn className="size-4" /> Sign in with ChatGPT
            </a>
          )}
        </header>

        <section className="grid gap-5 xl:grid-cols-[390px_minmax(0,1fr)]">
          <aside className="self-start rounded-2xl border border-border bg-card p-5 shadow-[0_18px_50px_rgb(15_23_42/0.06)] xl:sticky xl:top-6">
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-semibold">Connection</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  Base URL and model are remembered on this device.
                </p>
              </div>
              <ShieldCheck className="size-5 text-emerald-600" />
            </div>

            {user ? (
              <div className="mb-4 space-y-3 rounded-xl border border-emerald-200 bg-emerald-50/55 p-3">
                <label className="block space-y-1.5 text-xs font-medium text-emerald-950">
                  Saved connection
                  <select
                    value={selectedProfileId}
                    onChange={(event) => selectProfile(event.target.value)}
                    disabled={isRunning || profileBusy}
                    className="h-10 w-full rounded-lg border border-emerald-200 bg-white px-3 text-xs outline-none focus:ring-2 focus:ring-emerald-500/30"
                  >
                    <option value="">New / one-time connection</option>
                    {profiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label
                  htmlFor="profile-name"
                  className="block space-y-1.5 text-xs font-medium text-emerald-950"
                >
                  Save as name
                  <Input
                    id="profile-name"
                    value={profileName}
                    onChange={(event) => {
                      setProfileName(event.target.value);
                      if (selectedProfileId) setProfileDirty(true);
                    }}
                    disabled={isRunning || profileBusy}
                    placeholder="e.g. My Anthropic gateway"
                    className="h-9 bg-white text-xs"
                  />
                </label>
              </div>
            ) : (
              <div className="mb-4 rounded-xl border border-blue-200 bg-blue-50/70 p-3 text-xs leading-5 text-blue-950">
                <a
                  href={signInPath}
                  target="_top"
                  className="font-semibold underline underline-offset-2"
                >
                  Sign in with ChatGPT
                </a>{' '}
                to save encrypted connection profiles and test history.
                Anonymous testing still works.
              </div>
            )}

            <form onSubmit={runTests} className="space-y-4">
              <fieldset disabled={isRunning} className="space-y-1.5">
                <legend className="text-xs font-medium text-muted-foreground">
                  API type
                </legend>
                <div className="grid grid-cols-2 gap-2 rounded-xl bg-muted/70 p-1">
                  {(['anthropic', 'openai'] as const).map((item) => (
                    <button
                      key={item}
                      type="button"
                      onClick={() => chooseType(item)}
                      aria-pressed={apiType === item}
                      className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-2 text-xs font-semibold transition-colors ${apiType === item ? 'bg-white text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                    >
                      {item === 'anthropic' ? (
                        <Bot className="size-3.5" />
                      ) : (
                        <Code2 className="size-3.5" />
                      )}
                      {item === 'anthropic' ? 'Anthropic' : 'OpenAI'}
                    </button>
                  ))}
                </div>
                <span className="block text-[10px] font-normal leading-4 text-muted-foreground">
                  This chooses the request format and how token usage is read.
                </span>
              </fieldset>

              <label
                htmlFor="base-url"
                className="block space-y-1.5 text-xs font-medium text-muted-foreground"
              >
                Base URL
                <Input
                  id="base-url"
                  name="base_url"
                  type="url"
                  autoComplete="url"
                  value={baseUrl}
                  onChange={(event) => {
                    updateConnection({ baseUrl: event.target.value });
                    if (selectedProfileId) setProfileDirty(true);
                  }}
                  disabled={isRunning}
                  placeholder={
                    apiType === 'anthropic'
                      ? 'https://api.anthropic.com'
                      : 'https://api.openai.com/v1'
                  }
                  className="h-10 bg-background font-mono text-xs"
                />
                <span className="block text-[10px] font-normal leading-4 text-muted-foreground">
                  Use the provider root. The tester adds the correct Messages or
                  Chat Completions path.
                </span>
              </label>

              <label
                htmlFor="model-name"
                className="block space-y-1.5 text-xs font-medium text-muted-foreground"
              >
                Model
                {selectedProfileId && profileModels.length ? (
                  <select
                    id="model-name"
                    value={model}
                    onChange={(event) =>
                      updateConnection({ model: event.target.value })
                    }
                    disabled={isRunning}
                    className="h-10 w-full rounded-lg border border-input bg-background px-3 font-mono text-xs outline-none focus:ring-2 focus:ring-ring/30"
                  >
                    {profileModels.map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Input
                    id="model-name"
                    name="model"
                    value={model}
                    onChange={(event) =>
                      updateConnection({ model: event.target.value })
                    }
                    disabled={isRunning}
                    placeholder={
                      apiType === 'anthropic'
                        ? 'e.g. claude-sonnet-4-6'
                        : 'Enter the provider model name'
                    }
                    className="h-10 bg-background font-mono text-xs"
                  />
                )}
              </label>

              {user ? (
                <div className="space-y-2 rounded-xl border border-border/70 bg-muted/35 p-3">
                  <p className="text-xs font-medium">
                    Models saved in this profile
                  </p>
                  {profileModels.length ? (
                    <div className="flex flex-wrap gap-1.5">
                      {profileModels.map((item) => (
                        <span
                          key={item}
                          className="inline-flex items-center gap-1 rounded-md border border-border bg-white px-2 py-1 font-mono text-[10px]"
                        >
                          {item}
                          <button
                            type="button"
                            onClick={() => removeModel(item)}
                            aria-label={`Remove ${item}`}
                            className="text-muted-foreground hover:text-rose-700"
                          >
                            <X className="size-3" />
                          </button>
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[10px] text-muted-foreground">
                      The current model is included when you save.
                    </p>
                  )}
                  <div className="flex gap-2">
                    <Input
                      value={newModel}
                      onChange={(event) => setNewModel(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          addModel();
                        }
                      }}
                      disabled={isRunning || profileBusy}
                      placeholder="Add another model"
                      className="h-8 bg-white font-mono text-[11px]"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={addModel}
                      disabled={!newModel.trim()}
                      className="h-8 gap-1"
                    >
                      <Plus className="size-3" /> Add
                    </Button>
                  </div>
                </div>
              ) : null}

              <label
                htmlFor="api-key"
                className="block space-y-1.5 text-xs font-medium text-muted-foreground"
              >
                API key
                <div className="relative">
                  <KeyRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="api-key"
                    name="api_key"
                    type={showKey ? 'text' : 'password'}
                    autoComplete="off"
                    value={apiKey}
                    onChange={(event) => {
                      setApiKey(event.target.value);
                      if (selectedProfileId) setProfileDirty(true);
                    }}
                    disabled={isRunning}
                    placeholder={
                      selectedProfile
                        ? 'Saved securely — enter only to replace'
                        : 'Paste your own key'
                    }
                    className="h-10 bg-background pl-9 pr-10 font-mono text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((current) => !current)}
                    className="absolute right-2 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label={showKey ? 'Hide API key' : 'Show API key'}
                  >
                    {showKey ? (
                      <EyeOff className="size-4" />
                    ) : (
                      <Eye className="size-4" />
                    )}
                  </button>
                </div>
              </label>

              {user ? (
                <div className="grid grid-cols-[1fr_auto] gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={saveProfile}
                    disabled={
                      profileBusy ||
                      isRunning ||
                      !profileName.trim() ||
                      (!selectedProfileId && !apiKey.trim())
                    }
                    className="h-9 gap-2"
                  >
                    <Save className="size-3.5" />
                    {selectedProfileId
                      ? profileDirty
                        ? 'Save changes'
                        : 'Profile saved'
                      : 'Save profile'}
                  </Button>
                  {selectedProfileId ? (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={deleteProfile}
                      disabled={profileBusy || isRunning}
                      className="h-9 px-3 text-rose-700 hover:text-rose-800"
                      aria-label="Delete profile"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  ) : null}
                </div>
              ) : null}

              {profileMessage ? (
                <p className="text-[11px] leading-4 text-muted-foreground">
                  {profileMessage}
                </p>
              ) : null}
              {formError ? (
                <Alert variant="destructive" className="px-3 py-2.5">
                  <AlertTriangle />
                  <AlertTitle>Check your settings</AlertTitle>
                  <AlertDescription>{formError}</AlertDescription>
                </Alert>
              ) : null}
              {isRunning ? (
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 w-full gap-2"
                  onClick={() => abortRef.current?.abort()}
                >
                  <Square className="size-3.5 fill-current" /> Stop test
                </Button>
              ) : (
                <Button
                  type="submit"
                  className="h-11 w-full gap-2 bg-[#f3a712] text-[#172033] hover:bg-[#e99a02]"
                >
                  <Play className="size-4 fill-current" /> Run 12-question check
                </Button>
              )}
            </form>

            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/75 p-3 text-xs leading-5 text-amber-950">
              <strong>Key handling:</strong> one-time keys only pass through the
              relay while testing. Saved keys are encrypted on the server and
              never shown again. Use a temporary, low-limit key.
            </div>
          </aside>

          <div className="min-w-0 space-y-5">
            <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card p-1.5 shadow-sm">
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => setViewMode('current')}
                  className={`inline-flex h-9 items-center gap-2 rounded-lg px-3 text-xs font-semibold ${viewMode === 'current' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}
                >
                  <Activity className="size-3.5" /> Current results
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('saved')}
                  className={`inline-flex h-9 items-center gap-2 rounded-lg px-3 text-xs font-semibold ${viewMode === 'saved' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}
                >
                  <History className="size-3.5" /> Saved runs{' '}
                  {user ? `(${runs.length})` : ''}
                </button>
              </div>
              {viewMode === 'current' ? (
                <div className="mr-1 flex items-center gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      if (runContext) exportEvidence(runContext, results);
                    }}
                    disabled={isRunning || !runContext || completed === 0}
                    className="h-8 gap-1.5 px-2.5 text-[11px]"
                  >
                    <Download className="size-3" /> Export evidence
                  </Button>
                  <button
                    type="button"
                    onClick={resetResults}
                    disabled={isRunning}
                    className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                  >
                    <RotateCcw className="size-3" /> Reset
                  </button>
                </div>
              ) : null}
            </div>

            {viewMode === 'saved' ? (
              <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-[0_18px_50px_rgb(15_23_42/0.06)]">
                <div className="border-b border-border px-5 py-4">
                  <h2 className="text-sm font-semibold">Private saved runs</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Completed tests are saved automatically when you are signed
                    in.
                  </p>
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
                        <LogIn className="size-4" /> Sign in with ChatGPT
                      </a>
                    </div>
                  </div>
                ) : !runs.length ? (
                  <div className="grid min-h-72 place-items-center p-8 text-center text-sm text-muted-foreground">
                    Your completed runs will appear here.
                  </div>
                ) : (
                  <div className="divide-y divide-border">
                    {runs.map((run) => {
                      const runVerdict = savedVerdict(run);
                      return (
                        <div
                          key={run.id}
                          className="flex items-center gap-4 px-5 py-4 hover:bg-muted/35"
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
                                className={runVerdict.className}
                              >
                                {runVerdict.label}
                              </Badge>
                            </div>
                            <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                              {run.modelName} · {run.baseUrl}
                            </p>
                            <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                              Median TTFT {durationOrDash(run.medianTtftMs)} ·
                              Total {durationOrDash(run.medianTotalTimeMs)} ·{' '}
                              {rateOrDash(run.medianOutputTokensPerSecond)}
                            </p>
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
                            title="Export evidence ZIP"
                          >
                            <Download className="size-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void deleteRun(run.id)}
                            disabled={historyBusy}
                            className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-rose-50 hover:text-rose-700"
                            aria-label="Delete saved run"
                          >
                            <Trash2 className="size-4" />
                          </button>
                          <ChevronRight className="size-4 text-muted-foreground" />
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            ) : (
              <>
                <div className="grid gap-5 lg:grid-cols-2">
                  <section
                    className={`rounded-2xl border p-5 shadow-[0_18px_50px_rgb(15_23_42/0.05)] ${overall.tone === 'danger' ? 'border-rose-200 bg-rose-50/70' : overall.tone === 'warning' ? 'border-amber-200 bg-amber-50/70' : overall.tone === 'success' ? 'border-emerald-200 bg-emerald-50/70' : 'border-border bg-card'}`}
                  >
                    <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                      Token verdict
                    </p>
                    <h2 className="mt-1 text-xl font-semibold tracking-tight">
                      {overall.title}
                    </h2>
                    <p className="mt-1 min-h-12 text-sm leading-6 text-muted-foreground">
                      {overall.description}
                    </p>
                    <div className="mt-4 grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
                      <div className="rounded-xl border border-border/70 bg-white/65 px-3 py-2.5">
                        <div className="font-mono text-lg font-semibold">
                          {completed}
                        </div>
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          Complete
                        </div>
                      </div>
                      <div className="rounded-xl border border-border/70 bg-white/65 px-3 py-2.5">
                        <div className="font-mono text-lg font-semibold text-emerald-700">
                          {normalCount}
                        </div>
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          Normal
                        </div>
                      </div>
                      <div className="rounded-xl border border-border/70 bg-white/65 px-3 py-2.5">
                        <div className="font-mono text-lg font-semibold text-rose-700">
                          {cacheCount + largeCount}
                        </div>
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          Anomaly
                        </div>
                      </div>
                      <div className="rounded-xl border border-border/70 bg-white/65 px-3 py-2.5">
                        <div className="font-mono text-lg font-semibold text-rose-700">
                          {errorCount}
                        </div>
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          Failed
                        </div>
                      </div>
                    </div>
                    <Progress
                      value={progress}
                      className="mt-4 [&_[data-slot=progress-indicator]]:bg-[#39a987]"
                      aria-label={`${progress}% complete`}
                    />
                  </section>

                  <section className="rounded-2xl border border-blue-200 bg-blue-50/55 p-5 shadow-[0_18px_50px_rgb(15_23_42/0.05)]">
                    <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                      Performance
                    </p>
                    <h2 className="mt-1 text-xl font-semibold tracking-tight">
                      {performanceSummary.measuredCount
                        ? `Median TTFT ${durationOrDash(performanceSummary.medianTtftMs)}`
                        : isRunning
                          ? 'Waiting for the first streamed token'
                          : 'No timing data yet'}
                    </h2>
                    <p className="mt-1 min-h-12 text-sm leading-6 text-muted-foreground">
                      Measured from this tester&apos;s relay to the provider
                      stream. DNS, TCP, and TLS are intentionally excluded.
                    </p>
                    <div className="mt-4 grid grid-cols-2 gap-2 text-center sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
                      <div className="rounded-xl border border-blue-200/80 bg-white/70 px-2 py-2.5">
                        <div className="font-mono text-sm font-semibold">
                          {durationOrDash(performanceSummary.medianTtftMs)}
                        </div>
                        <div className="text-[9px] uppercase tracking-wide text-muted-foreground">
                          TTFT
                        </div>
                      </div>
                      <div className="rounded-xl border border-blue-200/80 bg-white/70 px-2 py-2.5">
                        <div className="font-mono text-sm font-semibold">
                          {durationOrDash(
                            performanceSummary.medianGenerationMs,
                          )}
                        </div>
                        <div className="text-[9px] uppercase tracking-wide text-muted-foreground">
                          Generation
                        </div>
                      </div>
                      <div className="rounded-xl border border-blue-200/80 bg-white/70 px-2 py-2.5">
                        <div className="font-mono text-sm font-semibold">
                          {durationOrDash(performanceSummary.medianTotalTimeMs)}
                        </div>
                        <div className="text-[9px] uppercase tracking-wide text-muted-foreground">
                          Total
                        </div>
                      </div>
                      <div className="rounded-xl border border-blue-200/80 bg-white/70 px-2 py-2.5">
                        <div className="font-mono text-sm font-semibold">
                          {rateOrDash(
                            performanceSummary.medianOutputTokensPerSecond,
                          )}
                        </div>
                        <div className="text-[9px] uppercase tracking-wide text-muted-foreground">
                          Output speed
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
                      max_tokens=96 · stream=true
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
                                          ? 'animate-pulse'
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
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
