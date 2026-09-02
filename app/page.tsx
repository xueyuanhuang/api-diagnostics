'use client';

import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  LockKeyhole,
  Play,
  RotateCcw,
  ShieldCheck,
  Square,
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
import { NORMAL_QUESTIONS } from '@/lib/questions';

const DEFAULT_ENDPOINT = 'https://inference-api.worldrouter.ai/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const SETTINGS_KEY = 'normal-token-check:connection:v1';

type ResultStatus = 'waiting' | 'running' | 'normal' | 'cached' | 'large' | 'error';

type TestResult = {
  id: string;
  category: string;
  prompt: string;
  status: ResultStatus;
  httpStatus?: number;
  returnedModel?: string | null;
  inputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  totalInputTokens?: number | null;
  outputTokens?: number | null;
  requestId?: string | null;
  answer?: string;
  rawResponse?: string;
  error?: string;
};

type ApiResponse = Omit<TestResult, 'id' | 'category' | 'prompt' | 'status'> & {
  error?: string;
};

const initialResults = (): TestResult[] =>
  NORMAL_QUESTIONS.map((question) => ({ ...question, status: 'waiting' }));

function numberOrDash(value: number | null | undefined) {
  return typeof value === 'number' ? value.toLocaleString() : '—';
}

function classifyResult(result: ApiResponse): ResultStatus {
  if (!result.httpStatus || result.httpStatus < 200 || result.httpStatus >= 300) return 'error';
  if (typeof result.totalInputTokens !== 'number') return 'error';
  if (result.totalInputTokens >= 1_000) return 'large';
  if ((result.cacheCreationInputTokens ?? 0) > 0 || (result.cacheReadInputTokens ?? 0) > 0) {
    return 'cached';
  }
  return 'normal';
}

function verdict(status: ResultStatus) {
  if (status === 'normal') {
    return {
      label: 'Normal',
      icon: CheckCircle2,
      className: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    };
  }
  if (status === 'cached') {
    return {
      label: 'Cache found',
      icon: AlertTriangle,
      className: 'border-amber-200 bg-amber-50 text-amber-900',
    };
  }
  if (status === 'large') {
    return {
      label: 'Large context',
      icon: AlertTriangle,
      className: 'border-rose-200 bg-rose-50 text-rose-800',
    };
  }
  if (status === 'error') {
    return {
      label: 'Failed',
      icon: XCircle,
      className: 'border-rose-200 bg-rose-50 text-rose-800',
    };
  }
  return {
    label: status === 'running' ? 'Testing' : 'Waiting',
    icon: Activity,
    className: 'border-slate-200 bg-slate-50 text-slate-600',
  };
}

export default function Home() {
  const [endpoint, setEndpoint] = useState(DEFAULT_ENDPOINT);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [settingsReady, setSettingsReady] = useState(false);
  const [results, setResults] = useState<TestResult[]>(initialResults);
  const [isRunning, setIsRunning] = useState(false);
  const [formError, setFormError] = useState('');
  const [runMessage, setRunMessage] = useState('Ready for a new 12-question check.');
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(SETTINGS_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as { endpoint?: string; model?: string };
        if (parsed.endpoint) setEndpoint(parsed.endpoint);
        if (parsed.model) setModel(parsed.model);
      }
    } catch {
      // Invalid device-local settings fall back to the safe defaults.
    } finally {
      setSettingsReady(true);
    }
  }, []);

  useEffect(() => {
    if (!settingsReady) return;
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ endpoint, model }));
  }, [endpoint, model, settingsReady]);

  const completed = results.filter((result) =>
    ['normal', 'cached', 'large', 'error'].includes(result.status),
  ).length;
  const normalCount = results.filter((result) => result.status === 'normal').length;
  const cacheCount = results.filter((result) => result.status === 'cached').length;
  const largeCount = results.filter((result) => result.status === 'large').length;
  const errorCount = results.filter((result) => result.status === 'error').length;
  const progress = Math.round((completed / NORMAL_QUESTIONS.length) * 100);

  const overall = useMemo(() => {
    if (isRunning) {
      return {
        tone: 'running',
        title: `Testing question ${Math.min(completed + 1, NORMAL_QUESTIONS.length)} of ${NORMAL_QUESTIONS.length}`,
        description: 'Each request uses no system prompt, tools, or explicit cache settings.',
      };
    }
    if (completed === 0) {
      return {
        tone: 'ready',
        title: 'Ready to check',
        description: 'Normal requests should have small inputs and zero cache usage.',
      };
    }
    if (largeCount > 0) {
      return {
        tone: 'danger',
        title: 'Large hidden context detected',
        description: `${largeCount} request${largeCount === 1 ? '' : 's'} reported at least 1,000 total input tokens.`,
      };
    }
    if (cacheCount > 0) {
      return {
        tone: 'warning',
        title: 'Unexpected cache activity detected',
        description: `${cacheCount} request${cacheCount === 1 ? '' : 's'} included cached input even though the test did not request caching.`,
      };
    }
    if (errorCount > 0) {
      return {
        tone: 'danger',
        title: 'Test incomplete',
        description: `${errorCount} request${errorCount === 1 ? '' : 's'} failed. Check the key and endpoint, then retry.`,
      };
    }
    if (completed < NORMAL_QUESTIONS.length) {
      return {
        tone: 'ready',
        title: 'Run stopped',
        description: `${completed} of ${NORMAL_QUESTIONS.length} questions completed. Run the full set before judging the result.`,
      };
    }
    return {
      tone: 'success',
      title: 'No large token anomaly detected',
      description: `All ${normalCount} completed requests used small, uncached inputs in this run. This is not proof of permanent zero injection.`,
    };
  }, [cacheCount, completed, errorCount, isRunning, largeCount, normalCount]);

  function updateResult(index: number, patch: Partial<TestResult>) {
    setResults((current) =>
      current.map((result, resultIndex) =>
        resultIndex === index ? { ...result, ...patch } : result,
      ),
    );
  }

  async function runTests(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isRunning) return;
    setFormError('');

    if (endpoint !== DEFAULT_ENDPOINT) {
      setFormError('For safety, this public tester only supports the WorldRouter Messages endpoint.');
      return;
    }
    if (!apiKey.trim()) {
      setFormError('Enter your own API key to start the test.');
      return;
    }
    if (!model.trim()) {
      setFormError('Enter a model name.');
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setIsRunning(true);
    setRunMessage('Running ordinary questions one at a time…');
    setResults(initialResults());

    try {
      for (let index = 0; index < NORMAL_QUESTIONS.length; index += 1) {
        if (controller.signal.aborted) break;
        const question = NORMAL_QUESTIONS[index];
        updateResult(index, { status: 'running' });

        try {
          const response = await fetch('/api/test', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              endpoint,
              apiKey: apiKey.trim(),
              model: model.trim(),
              prompt: question.prompt,
            }),
            cache: 'no-store',
            signal: controller.signal,
          });
          const data = (await response.json()) as ApiResponse;
          if (!response.ok || data.error) {
            throw new Error(data.error || `Request failed with status ${response.status}.`);
          }
          updateResult(index, { ...data, status: classifyResult(data) });
        } catch (error) {
          if (controller.signal.aborted) break;
          updateResult(index, {
            status: 'error',
            error: error instanceof Error ? error.message : 'Unknown request error.',
          });
        }
      }
      setRunMessage(controller.signal.aborted ? 'Test stopped. You can start a fresh run.' : 'Test complete.');
    } finally {
      setIsRunning(false);
      abortRef.current = null;
    }
  }

  function resetResults() {
    if (isRunning) return;
    setResults(initialResults());
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
              Run twelve ordinary questions and inspect direct, cached, and total input
              tokens—without synthetic filler prompts.
            </p>
          </div>
          <Badge variant="outline" className="h-7 gap-1.5 border-emerald-200 bg-emerald-50 px-3 text-emerald-800">
            <LockKeyhole className="size-3.5" />
            Public BYOK tester
          </Badge>
        </header>

        <section className="grid gap-5 xl:grid-cols-[370px_minmax(0,1fr)]">
          <aside className="self-start rounded-2xl border border-border bg-card p-5 shadow-[0_18px_50px_rgb(15_23_42/0.06)] xl:sticky xl:top-6">
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-semibold">Connection</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  Endpoint and model are remembered on this device.
                </p>
              </div>
              <ShieldCheck className="size-5 text-emerald-600" />
            </div>

            <form onSubmit={runTests} className="space-y-4">
              <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
                Endpoint
                <Input
                  name="endpoint"
                  type="url"
                  autoComplete="url"
                  value={endpoint}
                  onChange={(event) => setEndpoint(event.target.value)}
                  disabled={isRunning}
                  className="h-10 bg-background font-mono text-xs"
                />
              </label>
              <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
                Model
                <Input
                  name="model"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  disabled={isRunning}
                  className="h-10 bg-background font-mono text-xs"
                />
              </label>
              <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
                API key
                <div className="relative">
                  <KeyRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    name="api_key"
                    type={showKey ? 'text' : 'password'}
                    autoComplete="current-password"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    disabled={isRunning}
                    placeholder="Paste your own key"
                    className="h-10 bg-background pl-9 pr-10 font-mono text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((current) => !current)}
                    className="absolute right-2 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    aria-label={showKey ? 'Hide API key' : 'Show API key'}
                  >
                    {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
              </label>

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
                  <Square className="size-3.5 fill-current" />
                  Stop test
                </Button>
              ) : (
                <Button type="submit" className="h-11 w-full gap-2 bg-[#f3a712] text-[#172033] hover:bg-[#e99a02]">
                  <Play className="size-4 fill-current" />
                  Run 12-question check
                </Button>
              )}
            </form>

            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/75 p-3 text-xs leading-5 text-amber-950">
              <strong className="font-semibold">Key handling:</strong> WorldRouter blocks direct browser calls, so your key passes through this site’s stateless relay while each test runs. It is never saved or returned. Use a temporary, low-limit key.
            </div>

            <div className="mt-3 flex items-center justify-between gap-3 text-[11px] leading-4 text-muted-foreground">
              <span>Results remain only in this tab.</span>
              <button type="button" onClick={resetResults} disabled={isRunning} className="inline-flex items-center gap-1 hover:text-foreground disabled:opacity-40">
                <RotateCcw className="size-3" /> Reset
              </button>
            </div>
          </aside>

          <div className="min-w-0 space-y-5">
            <section
              className={`rounded-2xl border p-5 shadow-[0_18px_50px_rgb(15_23_42/0.05)] ${
                overall.tone === 'danger'
                  ? 'border-rose-200 bg-rose-50/70'
                  : overall.tone === 'warning'
                    ? 'border-amber-200 bg-amber-50/70'
                    : overall.tone === 'success'
                      ? 'border-emerald-200 bg-emerald-50/70'
                      : 'border-border bg-card'
              }`}
            >
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Overall verdict</p>
                  <h2 className="mt-1 text-xl font-semibold tracking-tight">{overall.title}</h2>
                  <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">{overall.description}</p>
                </div>
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-xl border border-border/70 bg-white/65 px-4 py-2.5">
                    <div className="font-mono text-lg font-semibold">{completed}</div>
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Complete</div>
                  </div>
                  <div className="rounded-xl border border-border/70 bg-white/65 px-4 py-2.5">
                    <div className="font-mono text-lg font-semibold text-emerald-700">{normalCount}</div>
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Normal</div>
                  </div>
                  <div className="rounded-xl border border-border/70 bg-white/65 px-4 py-2.5">
                    <div className="font-mono text-lg font-semibold text-rose-700">{cacheCount + largeCount}</div>
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Anomaly</div>
                  </div>
                </div>
              </div>
              <Progress value={progress} className="mt-4 [&_[data-slot=progress-indicator]]:bg-[#39a987]" aria-label={`${progress}% complete`} />
            </section>

            <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-[0_18px_50px_rgb(15_23_42/0.06)]">
              <div className="flex flex-col gap-2 border-b border-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-sm font-semibold">Question-by-question usage</h2>
                  <p className="mt-1 text-xs text-muted-foreground">{runMessage}</p>
                </div>
                <div className="font-mono text-[10px] text-muted-foreground">TOTAL INPUT = DIRECT + CACHE WRITE + CACHE READ</div>
              </div>

              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/45 hover:bg-muted/45">
                    <TableHead className="min-w-[360px] pl-5">Question</TableHead>
                    <TableHead className="text-right">Direct</TableHead>
                    <TableHead className="text-right">Cache write</TableHead>
                    <TableHead className="text-right">Cache read</TableHead>
                    <TableHead className="text-right">Total input</TableHead>
                    <TableHead className="text-right">Output</TableHead>
                    <TableHead className="pr-5 text-right">Verdict</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {results.map((result, index) => {
                    const itemVerdict = verdict(result.status);
                    const VerdictIcon = itemVerdict.icon;
                    return (
                      <TableRow key={result.id} className={result.status === 'running' ? 'bg-blue-50/60' : undefined}>
                        <TableCell className="max-w-[560px] whitespace-normal py-4 pl-5 align-top">
                          <div className="flex items-start gap-3">
                            <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-muted font-mono text-[10px] text-muted-foreground">
                              {String(index + 1).padStart(2, '0')}
                            </span>
                            <div className="min-w-0">
                              <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground">{result.category}</div>
                              <p className="text-sm leading-5">{result.prompt}</p>
                              {result.answer || result.error ? (
                                <details className="mt-2 text-xs text-muted-foreground">
                                  <summary className="cursor-pointer select-none font-medium text-foreground/70 hover:text-foreground">View response details</summary>
                                  <div className="mt-2 rounded-lg bg-muted/60 p-3 leading-5">
                                    {result.error ? <p className="text-rose-700">{result.error}</p> : <p className="whitespace-pre-wrap">{result.answer}</p>}
                                    {result.requestId ? <p className="mt-2 break-all font-mono text-[10px]">Request ID: {result.requestId}</p> : null}
                                    {result.returnedModel ? <p className="mt-1 font-mono text-[10px]">Model: {result.returnedModel}</p> : null}
                                    {result.rawResponse ? (
                                      <details className="mt-2">
                                        <summary className="cursor-pointer">Raw response</summary>
                                        <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-md bg-slate-950 p-3 text-[10px] leading-4 text-slate-100">{result.rawResponse}</pre>
                                      </details>
                                    ) : null}
                                  </div>
                                </details>
                              ) : null}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="text-right align-top font-mono text-xs">{numberOrDash(result.inputTokens)}</TableCell>
                        <TableCell className="text-right align-top font-mono text-xs">{numberOrDash(result.cacheCreationInputTokens)}</TableCell>
                        <TableCell className="text-right align-top font-mono text-xs">{numberOrDash(result.cacheReadInputTokens)}</TableCell>
                        <TableCell className={`text-right align-top font-mono text-xs font-semibold ${result.status === 'large' ? 'text-rose-700' : ''}`}>{numberOrDash(result.totalInputTokens)}</TableCell>
                        <TableCell className="text-right align-top font-mono text-xs">{numberOrDash(result.outputTokens)}</TableCell>
                        <TableCell className="pr-5 text-right align-top">
                          <Badge variant="outline" className={`gap-1 ${itemVerdict.className}`}>
                            <VerdictIcon className={result.status === 'running' ? 'animate-pulse' : ''} />
                            {itemVerdict.label}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </section>

            <p className="px-1 pb-4 text-xs leading-5 text-muted-foreground">
              A clean run means no large anomaly was detected in these twelve requests. Routing can change over time, so one clean run cannot prove permanent zero injection.
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
