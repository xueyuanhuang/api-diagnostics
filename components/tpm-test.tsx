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
  tpmStageMetrics,
  TPM_LEVELS,
  TPM_TOKEN_BUDGET,
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
  const stages = run ? tpmStageMetrics(run) : [];
  const limits = [
    ...new Map(
      (metrics?.reportedLimits ?? []).map((h) => [h.header, h]),
    ).values(),
  ];
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
          <h2 className="text-xl font-semibold">
            Adaptive tokens per minute test
          </h2>
          <p className="text-sm leading-6 text-muted-foreground">
            Automatically increase load and measure input/output throughput. See
            the highest clean rate tested and any provider-reported limits.
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
                Automatic load levels: {TPM_LEVELS.join(' → ')} concurrent
                requests.
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
              Up to 15 seconds sending per level, then wait for pending
              responses. At most {TPM_MAX_REQUESTS} requests and{' '}
              {TPM_TOKEN_BUDGET.toLocaleString()} estimated tokens, including
              the first check and any confirmation. New requests stop after 3
              minutes; final responses can take up to 45 seconds longer. Stop is
              available throughout.
            </p>
          </div>
          <p className="text-sm leading-6 text-muted-foreground">
            The first request calibrates token usage and is excluded from rates.
            A clear token-limit error pauses load. If the provider supplies a
            cooldown of at most 60 seconds and budget remains, the same load is
            repeated once. Other errors stop the test and keep their evidence.
          </p>
          <p className="text-xs leading-5 text-muted-foreground">
            The token budget reserves measured input plus 10% and the full
            output allowance before each request. It is an estimate, not a
            billing cap. Provider usage may be charged. Actual input tokens
            depend on the model and are reported after each response. Uses your
            selected API format and Standard/Flex resource. Keep this tab open;
            switching test views is supported.
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
                ? run?.phase === 'cooldown'
                  ? `Waiting for provider cooldown until ${new Date(run.cooldownUntil ?? 0).toLocaleTimeString()}…`
                  : run?.phase === 'check'
                    ? 'Checking the connection and calibrating token usage…'
                    : `Measuring ${run?.stages?.at(-1)?.concurrency ?? 2} concurrent requests${run?.phase === 'confirmation' ? ' · confirmation' : ''}…`
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
                ['Measured input TPM', metrics.inputTpm],
                ['Measured output TPM', metrics.outputTpm],
                ['Measured combined TPM', metrics.totalTpm],
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
              {metrics.totalSucceeded} successful / {metrics.attempts} attempted
              · {metrics.errors} errors · {metrics.http429} HTTP 429 ·{' '}
              {(run.elapsedMs / 1000).toFixed(2)} seconds total ·{' '}
              {(metrics.measuredMs / 1000).toFixed(2)} seconds measured
              {!run.finished ? ' so far' : ''}.
            </p>
            <p className="text-sm">
              Usage coverage: {metrics.coverage} / {metrics.succeeded}{' '}
              successful responses. Counted {number(metrics.input)} input +{' '}
              {number(metrics.output)} output tokens. Cache reads:{' '}
              {number(metrics.cacheRead)} reported across{' '}
              {metrics.cacheReadReported} measured responses. Cache writes:{' '}
              {number(metrics.cacheWrite)} tokens.
              {metrics.uncachedInputTpm !== null && (
                <>
                  {' '}
                  Input excluding cache reads:{' '}
                  {number(metrics.uncachedInputTpm)} TPM (
                  {metrics.cacheReadReported}/{metrics.coverage} responses with
                  cache counts).
                </>
              )}
            </p>
            {metrics.missingUsage > 0 && (
              <p className="text-sm font-medium text-amber-800">
                Partial usage: these rates include only responses with both
                token counts. Missing usage is unknown, not zero.
              </p>
            )}
            {run.method === 'adaptive-v2' && (
              <div className="rounded-xl border border-border bg-muted/40 p-4 text-sm leading-6">
                <p className="font-semibold">Highest clean rate tested</p>
                {metrics.best ? (
                  <p>
                    {number(metrics.best.inputTpm)} input TPM ·{' '}
                    {number(metrics.best.outputTpm)} output TPM at{' '}
                    {metrics.best.concurrency} concurrent requests, observed for{' '}
                    {(metrics.best.elapsedMs / 1000).toFixed(2)} s.
                  </p>
                ) : (
                  <p>No complete, clean load level yet.</p>
                )}
                <p>
                  A clean level establishes performance for that workload, not
                  the route’s maximum or a sustained one-minute quota.
                </p>
                <p>
                  Estimated tokens reserved: {number(run.reservedTokens ?? 0)} /{' '}
                  {TPM_TOKEN_BUDGET.toLocaleString()}.
                </p>
              </div>
            )}
            {run.confirmationNote && (
              <p className="text-sm leading-6">
                <strong>Limit verification: </strong>
                {metrics.verification === 'repeated'
                  ? 'Token throttling occurred again after cooldown. This does not establish an exact numeric TPM limit. '
                  : metrics.verification === 'not-repeated'
                    ? 'The same load completed cleanly on the repeat; the earlier limit was not reproduced. '
                    : metrics.verification === 'inconclusive'
                      ? 'The repeat was incomplete or encountered another error. '
                      : ''}
                {run.confirmationNote}
              </p>
            )}
            <p className="text-xs leading-6 text-muted-foreground">
              {run.stopReason === 'budget'
                ? `Stopped at the ${run.method ? TPM_MAX_REQUESTS : 30}-request budget. `
                : run.stopReason === 'token-budget'
                  ? 'Stopped at the estimated-token budget. '
                  : run.stopReason === 'window'
                    ? 'The time budget ended. '
                    : run.stopReason === 'provider'
                      ? 'Request failures or missing usage were observed. '
                      : run.stopReason === 'tester'
                        ? 'The tester could not confirm a response. '
                        : run.stopReason === 'cancelled'
                          ? 'You stopped this run; some usage may be unreported. '
                          : run.finished
                            ? 'All planned load levels completed. '
                            : ''}
              TPM = reported tokens from successful complete responses ÷
              measured seconds × 60.
              {run.method === 'adaptive-v2'
                ? ' Measurements exclude the initial check and cooldown. Each level includes browser/relay overhead and waiting for its final responses.'
                : ' This legacy run includes the first check, browser/relay overhead and final responses.'}{' '}
              Input includes reported cache reads/writes; output includes
              reported reasoning tokens. Input excluding cache reads is an
              accounting subtotal, not a guaranteed quota counter. Short runs
              are minute-equivalent rates. Limits may apply to the account, key
              or route; cache rules, reserved output and other traffic can
              affect them.
            </p>
          </div>
          {stages.length > 0 && (
            <div className="rounded-2xl border border-border bg-card p-5">
              <h3 className="mb-3 font-semibold">Results by load level</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b">
                      {[
                        'Concurrent requests',
                        'Input TPM',
                        'Output TPM',
                        'Successful / attempts',
                        'Errors / 429',
                        'Observed time',
                        'Outcome',
                      ].map((label) => (
                        <th key={label} className="p-2">
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {stages.map((s) => (
                      <tr key={s.id} className="border-b align-top">
                        <td className="p-2">
                          {s.concurrency}
                          {s.kind === 'confirmation' && (
                            <p className="text-xs">Confirmation</p>
                          )}
                          <p className="text-xs text-muted-foreground">
                            Peak {s.peakPending} pending
                          </p>
                        </td>
                        <td className="p-2">{number(s.inputTpm)}</td>
                        <td className="p-2">{number(s.outputTpm)}</td>
                        <td className="p-2">
                          {s.succeeded} / {s.attempts}
                        </td>
                        <td className="p-2">
                          {s.errors} / {s.http429}
                        </td>
                        <td className="p-2">
                          {(s.elapsedMs / 1000).toFixed(2)} s
                        </td>
                        <td
                          className={`p-2 font-medium ${s.tokenLimit || s.errors ? 'text-red-800' : s.clean ? 'text-emerald-800' : 'text-amber-800'}`}
                        >
                          {!s.finished
                            ? 'Measuring'
                            : s.tokenLimit
                              ? 'Token limit reported'
                              : s.clean
                                ? 'Clean · limit not reached'
                                : s.errors
                                  ? 'Request failures'
                                  : 'Incomplete level'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-xs leading-5 text-muted-foreground">
                Pending counts include browser/relay time; they do not prove
                simultaneous model execution. Levels stop sending after 15
                seconds or their request allowance, then drain. Rates use each
                level’s full observed duration.
              </p>
            </div>
          )}
          <div className="rounded-2xl border border-border bg-card p-5">
            <h3 className="mb-3 font-semibold">Provider-reported limits</h3>
            {limits.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="p-2">Scope</th>
                      <th className="p-2">Reported limit</th>
                      <th className="p-2">Remaining</th>
                      <th className="p-2">Reset after</th>
                      <th className="p-2">Evidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {limits.map((h) => (
                      <tr key={h.header} className="border-b">
                        <td className="p-2">{h.scope}</td>
                        <td className="p-2">{number(h.limit)}</td>
                        <td className="p-2">{number(h.remaining)}</td>
                        <td className="p-2">
                          {h.resetMs === null
                            ? 'Not reported'
                            : `${number(h.resetMs / 1000)} s`}
                        </td>
                        <td className="p-2">Request {h.sequence}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No supported limit headers were returned. The configured TPM
                limit is unknown.
              </p>
            )}
            <p className="mt-3 text-xs leading-5 text-muted-foreground">
              Latest captured header values per scope, at response time. These
              are provider claims, not measured capacity or proof that the limit
              was reached. Original headers remain in each request’s evidence.
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
                      <td className="p-2">
                        {row.sequence}
                        {row.stage === 0 && (
                          <p className="text-xs">Initial check</p>
                        )}
                        {!!row.stage && (
                          <p className="text-xs">Level {row.stage}</p>
                        )}
                      </td>
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
