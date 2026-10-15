'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { RawData } from '@/components/raw-exchange-data';
import {
  DiagnosticHistorySave,
  useDiagnosticHistory,
} from '@/components/diagnostic-history-save';
import {
  diagnosticExport,
  type DiagnosticRunSummary,
  type TpmRun,
} from '@/lib/diagnostic-runs';
import {
  runTpmMeasurement,
  tpmMetrics,
  tpmRequestBody,
  tpmVerdict,
  TPM_WORKLOADS,
  TPM_MAX_REQUESTS,
  type TpmWorkload,
  type TpmExchange,
} from '@/lib/tpm-test';
import { openRouterRoute } from '@/lib/openrouter';
import { confirmHttpRisk, isInsecureHttp } from '@/lib/http-consent';

const number = (value: number | null) =>
  value === null
    ? 'Not available'
    : value.toLocaleString(undefined, { maximumFractionDigits: 1 });
export function TpmTest(props: {
  apiType: 'openai' | 'anthropic';
  baseUrl: string;
  model: string;
  openRouterTier?: string;
  apiKey: string;
  selectedProfileId: string;
  profileName: string;
  profileDirty: boolean;
  startBlocked: boolean;
  onRunningChange: (running: boolean) => void;
  signedIn?: boolean;
  onSaved?: (run: DiagnosticRunSummary) => void;
  savedRun?: TpmRun;
}) {
  const [workload, setWorkload] = useState<TpmWorkload>('balanced');
  const [runs, setRuns] = useState<TpmRun[]>(
    props.savedRun ? [props.savedRun] : [],
  );
  const [selectedId, setSelectedId] = useState('');
  const [running, setRunning] = useState(false);
  const [formError, setFormError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const history = useDiagnosticHistory(
    runs,
    Boolean(props.signedIn && !props.savedRun),
    props.onSaved,
  );
  const run = runs.find((item) => item.id === selectedId) ?? runs.at(-1);
  const metrics = run ? tpmMetrics(run) : null;
  const plan = TPM_WORKLOADS[workload];
  useEffect(() => () => controller.current?.abort(), []);
  async function start() {
    if (controller.current || props.startBlocked || props.savedRun) return;
    setFormError('');
    if (
      !props.model.trim() ||
      !props.baseUrl.trim() ||
      (!props.selectedProfileId && !props.apiKey.trim())
    ) {
      setFormError(
        'Choose a saved connection, or enter a base URL, model and API key.',
      );
      return;
    }
    if (props.profileDirty && props.selectedProfileId) {
      setFormError('Save the edited connection first.');
      return;
    }
    if (!confirmHttpRisk([props.baseUrl], (message) => window.confirm(message)))
      return;
    const abort = new AbortController();
    controller.current = abort;
    const item: TpmRun = {
      id: crypto.randomUUID(),
      testKind: 'tpm',
      apiType: props.apiType,
      baseUrl: props.baseUrl.trim(),
      model: props.model.trim(),
      profileId: props.selectedProfileId || null,
      label: `${props.profileName || 'One-time connection'}${props.openRouterTier ? ` · ${props.openRouterTier === 'flex' ? 'Flex' : 'Standard'} requested` : ''}`,
      createdAt: new Date().toISOString(),
      workload,
      elapsedMs: 0,
      stopReason: null,
      finished: false,
      rows: [],
    };
    const payload = {
      apiType: props.apiType,
      model: item.model,
      openRouterTier: props.openRouterTier,
      profileId: props.selectedProfileId || undefined,
      baseUrl: props.selectedProfileId ? undefined : props.baseUrl.trim(),
      apiKey: props.selectedProfileId ? undefined : props.apiKey.trim(),
      allowInsecureHttp: isInsecureHttp(props.baseUrl),
      workload,
    };
    setRuns((all) => [...all, item]);
    setSelectedId(item.id);
    setRunning(true);
    props.onRunningChange(true);
    try {
      await runTpmMeasurement({
        workload,
        signal: abort.signal,
        request: async (sequence) => {
          const response = await fetch('/api/tpm-test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ...payload,
              nonce: `${item.id}-${sequence}`,
            }),
            signal: AbortSignal.any([
              abort.signal,
              AbortSignal.timeout(55_000),
            ]),
          });
          let data: { exchange?: TpmExchange; error?: string };
          try {
            data = await response.json();
          } catch {
            throw new Error(
              `Tester returned unreadable data (HTTP ${response.status}); no provider result confirmed.`,
            );
          }
          if (!response.ok || !data.exchange)
            throw new Error(
              data.error || `Tester request failed (HTTP ${response.status}).`,
            );
          return data.exchange;
        },
        publish: (measurement) =>
          setRuns((all) =>
            all.map((saved) =>
              saved.id === item.id ? { ...item, ...measurement } : saved,
            ),
          ),
      });
    } finally {
      controller.current = null;
      setRunning(false);
      props.onRunningChange(false);
    }
  }
  function download() {
    if (!run) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(diagnosticExport(run), null, 2)], {
        type: 'application/json',
      }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `tpm-${run.id}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  let route = {};
  try {
    route =
      openRouterRoute(
        props.baseUrl,
        props.apiType,
        props.model,
        props.openRouterTier,
      ) ?? {};
  } catch {
    /* Server will validate. */
  }
  return (
    <section aria-label="TPM Test" className="space-y-5">
      {!props.savedRun && (
        <div className="space-y-4 rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6">
          <h2 className="text-xl font-semibold">Tokens per minute test</h2>
          <p className="text-sm leading-6 text-muted-foreground">
            Measure how many input and output tokens your selected route
            processes under load. Choose a workload, then start.
          </p>
          <label className="block max-w-sm space-y-2 text-sm font-medium">
            Token workload
            <select
              aria-label="Token workload"
              value={workload}
              onChange={(e) => setWorkload(e.target.value as TpmWorkload)}
              disabled={running || props.startBlocked}
              className="block h-10 w-full rounded-lg border border-input bg-background px-3"
            >
              {Object.entries(TPM_WORKLOADS).map(([key, config]) => (
                <option key={key} value={key}>
                  {config.label}
                </option>
              ))}
            </select>
          </label>
          <div className="rounded-xl bg-muted/50 p-4 text-sm leading-6">
            <p>
              <strong>
                Up to 60 seconds sending · 5 concurrent requests · 30 requests
                maximum.
              </strong>
            </p>
            <p>
              {plan.characters.toLocaleString()} characters of source text per
              request, plus instructions. Output limit:{' '}
              {plan.outputLimit.toLocaleString()} tokens per request (
              {(TPM_MAX_REQUESTS * plan.outputLimit).toLocaleString()} maximum
              across the run, if honored).
            </p>
            <p>
              The first request checks the connection and counts toward the
              budget. Sending stops on an error; already-started requests
              finish. No automatic retries. Each request has a 45-second
              timeout; final responses can take the total run beyond 60 seconds.
            </p>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            Provider usage may be charged. Actual input tokens depend on the
            model and are reported after each response. Uses your selected API
            format and Standard/Flex resource. Keep this tab open; switching
            test views is supported.
          </p>
          <RawData
            title="Request preview · token workload"
            text={JSON.stringify(
              {
                ...tpmRequestBody(
                  props.apiType,
                  props.model,
                  workload,
                  'preview',
                ),
                ...route,
              },
              null,
              2,
            )}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              disabled={running || props.startBlocked}
              onClick={() => void start()}
            >
              Start TPM test
            </Button>
            {running && (
              <Button
                type="button"
                variant="outline"
                onClick={() => controller.current?.abort()}
              >
                Stop test
              </Button>
            )}
            <output className="text-sm text-muted-foreground">
              {running
                ? 'Measuring token throughput…'
                : run
                  ? 'Results below.'
                  : 'Ready to measure.'}
            </output>
          </div>
          {formError && (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          )}
        </div>
      )}
      {run && metrics && (
        <>
          {!props.savedRun && (
            <DiagnosticHistorySave
              signedIn={Boolean(props.signedIn)}
              status={history.statuses[run.id]}
              retry={() => history.retry(run.id)}
            />
          )}
          <div className="flex flex-wrap items-end gap-3">
            <label className="min-w-0 flex-1 text-sm">
              {props.savedRun ? 'Saved test' : 'Tests in this tab'}
              <select
                aria-label="TPM run"
                className="mt-2 block h-10 w-full rounded-lg border border-input bg-card px-3"
                value={run.id}
                onChange={(e) => setSelectedId(e.target.value)}
              >
                {runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label} · {r.model} · {TPM_WORKLOADS[r.workload].label} ·{' '}
                    {new Date(r.createdAt).toLocaleTimeString()}
                  </option>
                ))}
              </select>
            </label>
            <Button type="button" variant="outline" onClick={download}>
              Download evidence
            </Button>
          </div>
          <div className="space-y-4 rounded-2xl border border-border bg-card p-5">
            <Badge
              variant="outline"
              className={
                metrics.limitObserved || metrics.errors
                  ? 'border-red-300 bg-red-50 text-red-900'
                  : !run.finished ||
                      metrics.missingUsage ||
                      run.stopReason === 'cancelled'
                    ? 'border-amber-300 bg-amber-50 text-amber-900'
                    : 'border-emerald-300 bg-emerald-50 text-emerald-900'
              }
            >
              {tpmVerdict(run)}
            </Badge>
            <div className="grid gap-3 sm:grid-cols-3">
              {[
                ['Input TPM', metrics.inputTpm],
                ['Output TPM', metrics.outputTpm],
                ['Combined TPM', metrics.totalTpm],
              ].map(([label, value]) => (
                <div
                  key={String(label)}
                  className="rounded-xl border border-border p-4"
                >
                  <p className="text-sm text-muted-foreground">{label}</p>
                  <p className="mt-1 text-2xl font-semibold">
                    {number(value as number | null)}
                  </p>
                </div>
              ))}
            </div>
            <p className="text-sm">
              {metrics.succeeded} successful / {metrics.attempts} attempted ·{' '}
              {metrics.errors} errors · {metrics.http429} HTTP 429 ·{' '}
              {(run.elapsedMs / 1000).toFixed(2)} seconds observed
              {!run.finished ? ' so far' : ''}.
            </p>
            <p className="text-sm">
              Usage coverage: {metrics.coverage} / {metrics.succeeded}{' '}
              successful responses. Counted {number(metrics.input)} input +{' '}
              {number(metrics.output)} output tokens. Cache reads:{' '}
              {number(metrics.cacheRead)} reported across{' '}
              {metrics.cacheReadReported} responses.
            </p>
            {metrics.missingUsage > 0 && (
              <p className="text-sm font-medium text-amber-800">
                Partial usage: these rates include only responses with both
                token counts. Missing usage is unknown, not zero.
              </p>
            )}
            <p className="text-xs leading-6 text-muted-foreground">
              {run.stopReason === 'budget'
                ? 'Stopped at the 30-request budget. '
                : run.stopReason === 'window'
                  ? 'The sending window ended. '
                  : run.stopReason === 'provider'
                    ? 'Sending stopped after a response error or missing usage. '
                    : run.stopReason === 'tester'
                      ? 'The tester could not capture a response; delivery is unconfirmed. '
                      : run.stopReason === 'cancelled'
                        ? 'You stopped this run; some usage may be unreported. '
                        : ''}
              TPM = reported tokens from successful complete responses ÷
              observed seconds × 60. The period includes the first check,
              browser/relay overhead, and waiting for final responses. Input
              includes reported cache reads/writes; output includes reported
              reasoning tokens. This is workload throughput, not a proven
              provider maximum or a reconstruction of its quota counter. Short
              runs are minute-equivalent rates. Other traffic, cache rules, and
              reserved output can affect limits.
            </p>
          </div>
          <div className="rounded-2xl border border-border bg-card p-5">
            <h3 className="mb-3 font-semibold">Request results</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="p-2">Request</th>
                    <th className="p-2">HTTP / outcome</th>
                    <th className="p-2">Input tokens</th>
                    <th className="p-2">Output tokens</th>
                    <th className="p-2">Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {run.rows.map((row) => (
                    <tr key={row.sequence} className="border-b align-top">
                      <td className="p-2">{row.sequence}</td>
                      <td className="p-2">
                        {row.exchange?.httpStatus ?? '—'} · {row.status}
                        <p className="text-xs text-destructive">
                          {row.error || row.exchange?.issues.join(' ')}
                        </p>
                        {row.exchange?.limitKind && (
                          <p>Provider limit: {row.exchange.limitKind}</p>
                        )}
                      </td>
                      <td className="p-2">
                        {number(row.exchange?.inputTokens ?? null)}
                      </td>
                      <td className="p-2">
                        {number(row.exchange?.outputTokens ?? null)}
                      </td>
                      <td className="min-w-48 max-w-lg p-2">
                        {row.exchange && (
                          <details>
                            <summary className="cursor-pointer font-medium text-primary">
                              Request / response
                            </summary>
                            <div className="mt-2 space-y-2">
                              <RawData
                                title="Sent request"
                                text={`${row.exchange.requestMethod} ${row.exchange.requestUrl}\n${row.exchange.requestHeaders.map((h) => h.join(': ')).join('\n')}\n\n${row.exchange.requestBody}`}
                              />
                              <RawData
                                title="Received response · usage and limit headers"
                                text={`HTTP ${row.exchange.httpStatus}\n${row.exchange.responseHeaders.map((h) => h.join(': ')).join('\n')}\n\n${row.exchange.rawResponse}`}
                              />
                            </div>
                          </details>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
