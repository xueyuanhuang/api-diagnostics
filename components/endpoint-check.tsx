'use client';

import { useEffect, useRef, useState } from 'react';
import { Download, Play, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { RawData } from '@/components/raw-exchange-data';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { confirmHttpRisk, isInsecureHttp } from '@/lib/http-consent';
import {
  ENDPOINTS,
  ENDPOINT_CASES,
  endpointPlan,
  runEndpointSequence,
  type EndpointSelection,
  type EndpointTask,
  type EndpointSummary,
} from '@/lib/endpoint-check';
import type { HttpExchange } from '@/lib/http-exchange';

type Exchange = HttpExchange &
  EndpointSummary &
  Pick<EndpointTask, 'protocol' | 'caseId'>;
type Row = EndpointTask & {
  status: 'waiting' | 'running' | 'pass' | 'issue' | 'stopped';
  exchange: Exchange | null;
  error: string | null;
};
type Run = {
  id: string;
  label: string;
  model: string;
  createdAt: string;
  rows: Row[];
};
const number = (value: number | null | undefined) =>
  value == null ? '—' : value.toLocaleString();

export function EndpointCheck(props: {
  apiType: 'anthropic' | 'openai';
  baseUrl: string;
  model: string;
  apiKey: string;
  selectedProfileId: string;
  profileName: string;
  profileDirty: boolean;
  startBlocked: boolean;
  onRunningChange: (running: boolean) => void;
}) {
  const [selection, setSelection] = useState<EndpointSelection>('all');
  const [repeats, setRepeats] = useState(3);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [running, setRunning] = useState(false);
  const [formError, setFormError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const run = runs.find((item) => item.id === selectedId) ?? runs.at(-1);
  const plan = endpointPlan(selection, repeats);
  useEffect(() => () => controller.current?.abort(), []);

  function update(id: string, index: number, patch: Partial<Row>) {
    setRuns((all) =>
      all.map((item) =>
        item.id !== id
          ? item
          : {
              ...item,
              rows: item.rows.map((row, i) =>
                i === index ? { ...row, ...patch } : row,
              ),
            },
      ),
    );
  }
  async function start() {
    if (controller.current || props.startBlocked) return;
    setFormError('');
    if (
      !props.model.trim() ||
      !props.baseUrl.trim() ||
      (!props.selectedProfileId && !props.apiKey.trim())
    ) {
      setFormError(
        'Enter a base URL, model and API key, or choose a saved connection.',
      );
      return;
    }
    if (props.selectedProfileId && props.profileDirty) {
      setFormError(
        'Save the edited profile first so the test uses the connection shown.',
      );
      return;
    }
    let hostname: string;
    try {
      hostname = new URL(props.baseUrl).host;
    } catch {
      setFormError('Enter a valid provider URL.');
      return;
    }
    if (!confirmHttpRisk([props.baseUrl], (message) => window.confirm(message)))
      return;
    const abort = new AbortController();
    controller.current = abort;
    const id = crypto.randomUUID();
    const item: Run = {
      id,
      label: props.profileName.trim() || hostname,
      model: props.model.trim(),
      createdAt: new Date().toISOString(),
      rows: plan.map((task) => ({
        ...task,
        status: 'waiting',
        exchange: null,
        error: null,
      })),
    };
    // Snapshot the selected profile configuration. Protocol changes never select a different saved key.
    const payload = {
      apiType: props.apiType,
      model: item.model,
      profileId: props.selectedProfileId || undefined,
      baseUrl: props.selectedProfileId ? undefined : props.baseUrl.trim(),
      apiKey: props.selectedProfileId ? undefined : props.apiKey.trim(),
      allowInsecureHttp: isInsecureHttp(props.baseUrl),
    };
    setRuns((all) => [...all, item]);
    setSelectedId(id);
    setRunning(true);
    props.onRunningChange(true);
    try {
      await runEndpointSequence<{ exchange?: Exchange; error?: string }>({
        tasks: plan,
        signal: abort.signal,
        onStart: (index) => update(id, index, { status: 'running' }),
        request: async (task, signal) => {
          const response = await fetch('/api/endpoint-check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ...payload,
              protocol: task.protocol,
              caseId: task.caseId,
            }),
            signal,
          });
          return await response.json();
        },
        onResult: (index, result, error) => {
          const exchange = result?.exchange ?? null;
          const failure =
            error ||
            result?.error ||
            exchange?.error ||
            (!exchange ? 'No provider exchange was captured.' : null);
          update(id, index, {
            exchange,
            error: failure,
            status:
              failure ||
              !exchange?.captureComplete ||
              exchange.httpStatus == null ||
              exchange.httpStatus < 200 ||
              exchange.httpStatus >= 300 ||
              exchange.issues.length
                ? 'issue'
                : 'pass',
          });
        },
      });
    } catch {
      setFormError(
        'The test sequence stopped unexpectedly. Captured results are still available.',
      );
    } finally {
      setRuns((all) =>
        all.map((saved) =>
          saved.id !== id
            ? saved
            : {
                ...saved,
                rows: saved.rows.map((row) =>
                  ['waiting', 'running'].includes(row.status)
                    ? {
                        ...row,
                        status: 'stopped',
                        error:
                          row.status === 'running'
                            ? 'Stopped. The request may have reached the provider; its response was not captured.'
                            : 'Stopped before this request started.',
                      }
                    : row,
                ),
              },
        ),
      );
      controller.current = null;
      setRunning(false);
      props.onRunningChange(false);
    }
  }
  function download() {
    if (!run) return;
    const data = {
      format: 'three-endpoints-v1',
      captureNotes:
        'Application-level HTTP evidence. API keys and sensitive response headers are redacted; other response text is preserved, including reasoning and signature fields. Transport-added headers are not captured. Captures above 2 MiB or interrupted by timeout are marked partial. Usage is provider-reported, not verified billing.',
      prompts: ENDPOINT_CASES,
      stream: false,
      providerTimeoutMs: 120000,
      intervalAfterCompletionMs: 3000,
      ...run,
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `three-endpoints-${run.id}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const completed =
    run?.rows.filter((row) => row.exchange !== null).length ?? 0;
  const inputs =
    run?.rows
      .filter(
        (row) =>
          row.caseId === 'arithmetic' && row.exchange?.usage.totalInput != null,
      )
      .map((row) => row.exchange!.usage.totalInput!) ?? [];
  return (
    <section className="space-y-5" aria-label="Three Endpoints">
      <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold tracking-tight">
              Three Endpoints
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              Compare Messages, Chat Completions and Responses using the same
              base URL, key and model from Connection.
            </p>
          </div>
          <Badge variant="outline">Non-streaming</Badge>
        </div>
        <fieldset
          disabled={running || props.startBlocked}
          className="mt-5 flex flex-wrap gap-4"
        >
          <label className="space-y-2 text-xs font-medium">
            Endpoints
            <select
              value={selection}
              onChange={(event) =>
                setSelection(event.target.value as EndpointSelection)
              }
              className="block h-10 rounded-lg border border-border bg-background px-3 text-sm"
            >
              <option value="all">All three endpoints</option>
              {Object.entries(ENDPOINTS).map(([value, endpoint]) => (
                <option key={value} value={value}>
                  {endpoint.label}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-2 text-xs font-medium">
            Arithmetic requests per endpoint
            <select
              value={repeats}
              onChange={(event) => setRepeats(Number(event.target.value))}
              className="block h-10 rounded-lg border border-border bg-background px-3 text-sm"
            >
              <option value={3}>3 · compare token variation</option>
              <option value={1}>1 · quick check</option>
            </select>
          </label>
        </fieldset>
        <div className="mt-4 rounded-xl bg-muted/60 p-3 text-xs leading-6 text-muted-foreground">
          <p>
            One “OK” request (limit 4,096), then {repeats} arithmetic request
            {repeats === 1 ? '' : 's'} (limit 8,192) per endpoint.{' '}
            <strong className="text-foreground">
              {plan.length} paid requests
            </strong>
            , sent one at a time with a 3-second gap and a 120-second timeout.
          </p>
          <p>
            No system prompt, tools, history, explicit caching or sampling
            overrides. This checks basic text compatibility; results stay in
            this tab and can be downloaded.
          </p>
          <details className="mt-2">
            <summary className="cursor-pointer font-medium text-foreground">
              See the exact prompts
            </summary>
            {Object.values(ENDPOINT_CASES).map((sample) => (
              <p key={sample.label} className="mt-1 font-mono">
                {sample.prompt} → {sample.expected}
              </p>
            ))}
          </details>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            type="button"
            onClick={start}
            disabled={running || props.startBlocked}
          >
            <Play className="size-4" />{' '}
            {selection === 'all' ? 'Test all three' : 'Test endpoint'}
          </Button>
          {running ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => controller.current?.abort()}
            >
              <Square className="size-3.5" /> Stop
            </Button>
          ) : null}
          <output className="text-xs text-muted-foreground" aria-live="polite">
            {running
              ? `${completed} / ${run?.rows.length} captured · running`
              : run
                ? `${completed} / ${run.rows.length} captured`
                : 'Ready to test'}
          </output>
        </div>
        {formError ? (
          <p role="alert" className="mt-3 text-sm text-rose-700">
            {formError}
          </p>
        ) : null}
      </div>

      {run ? (
        <>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <label className="min-w-0 space-y-2 text-xs font-medium">
              Results in this tab
              <select
                aria-label="Endpoint comparison run"
                value={run.id}
                onChange={(event) => setSelectedId(event.target.value)}
                disabled={running}
                className="block h-10 w-full max-w-lg rounded-lg border border-border bg-card px-3 text-sm"
              >
                {runs.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label} · {item.model} ·{' '}
                    {new Date(item.createdAt).toLocaleTimeString()}
                  </option>
                ))}
              </select>
            </label>
            <Button type="button" variant="outline" onClick={download}>
              <Download className="size-4" /> Download raw JSON
            </Button>
          </div>
          {new Set(inputs).size > 1 ? (
            <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-950">
              Identical arithmetic prompts reported different total input counts
              ({[...new Set(inputs)].map(number).join(', ')}). Review the
              per-request usage and ask the provider to explain the variation.
            </p>
          ) : null}
          {Object.entries(ENDPOINTS).map(([protocol, endpoint]) => {
            const rows = run.rows
              .map((row, index) => ({ ...row, index }))
              .filter((row) => row.protocol === protocol);
            if (!rows.length) return null;
            return (
              <article
                key={protocol}
                className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border p-4">
                  <div>
                    <h3 className="font-semibold">{endpoint.label}</h3>
                    <p className="mt-1 font-mono text-xs text-muted-foreground">
                      POST {endpoint.path}
                    </p>
                  </div>
                  <Badge variant="outline">
                    {rows.filter((row) => row.status === 'pass').length} /{' '}
                    {rows.length} passed
                  </Badge>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Prompt</TableHead>
                      <TableHead>HTTP</TableHead>
                      <TableHead>Answer</TableHead>
                      <TableHead>Total input</TableHead>
                      <TableHead>Cached</TableHead>
                      <TableHead>Output</TableHead>
                      <TableHead>Time</TableHead>
                      <TableHead>Compatibility</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => (
                      <TableRow key={row.index}>
                        <TableCell className="whitespace-nowrap">
                          {ENDPOINT_CASES[row.caseId].label}
                          {row.caseId === 'arithmetic'
                            ? ` · ${row.repeat}`
                            : ''}
                        </TableCell>
                        <TableCell>{row.exchange?.httpStatus ?? '—'}</TableCell>
                        <TableCell>
                          <span
                            className="block max-w-28 truncate"
                            title={row.exchange?.answer}
                          >
                            {row.exchange?.answer || '—'}
                          </span>
                        </TableCell>
                        <TableCell>
                          {number(row.exchange?.usage.totalInput)}
                        </TableCell>
                        <TableCell>
                          {number(row.exchange?.usage.cacheRead)}
                        </TableCell>
                        <TableCell>
                          {number(row.exchange?.usage.output)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          {row.exchange
                            ? `${(row.exchange.totalTimeMs / 1000).toFixed(2)}s`
                            : '—'}
                        </TableCell>
                        <TableCell>
                          <span
                            className={
                              row.status === 'pass'
                                ? 'font-semibold text-emerald-700'
                                : row.status === 'issue'
                                  ? 'font-semibold text-rose-700'
                                  : 'text-muted-foreground'
                            }
                          >
                            {row.status === 'pass'
                              ? 'Pass'
                              : row.status === 'issue'
                                ? 'Issue'
                                : row.status === 'running'
                                  ? 'Running…'
                                  : row.status === 'stopped'
                                    ? 'Stopped'
                                    : 'Waiting'}
                          </span>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <div className="space-y-3 p-4">
                  {rows
                    .filter((row) => row.exchange || row.error)
                    .map((row) => (
                      <details
                        key={row.index}
                        className="rounded-xl border border-border"
                      >
                        <summary className="cursor-pointer px-3 py-3 text-xs font-medium">
                          {ENDPOINT_CASES[row.caseId].label} · request{' '}
                          {row.repeat} · details &amp; raw data
                          {row.exchange?.warnings.length
                            ? ' · usage warning'
                            : ''}
                        </summary>
                        <div className="space-y-3 border-t border-border p-3">
                          {row.error ? (
                            <p className="break-words text-xs text-rose-700">
                              {row.error}
                            </p>
                          ) : null}
                          {row.exchange ? (
                            <>
                              {row.exchange.issues.map((issue, i) => (
                                <p
                                  key={i}
                                  className="break-words text-xs text-rose-700"
                                >
                                  {issue}
                                </p>
                              ))}
                              {row.exchange.warnings.map((warning, i) => (
                                <p key={i} className="text-xs text-amber-800">
                                  {warning}
                                </p>
                              ))}
                              <p className="break-all text-xs leading-5 text-muted-foreground">
                                Returned model:{' '}
                                {row.exchange.returnedModel ?? '—'} · Finish:{' '}
                                {row.exchange.finishReason ?? '—'} · Capture:{' '}
                                {row.exchange.captureComplete
                                  ? 'complete'
                                  : 'partial'}
                                <br />
                                Uncached input:{' '}
                                {number(row.exchange.usage.uncachedInput)} ·
                                Cache write:{' '}
                                {number(row.exchange.usage.cacheWrite)} · Total
                                input + output:{' '}
                                {number(row.exchange.usage.total)}
                                <br />
                                Request ID:{' '}
                                {row.exchange.requestId ?? 'not provided'}
                              </p>
                              <RawData
                                title="Request · headers and body (key redacted)"
                                text={`${row.exchange.requestMethod} ${row.exchange.requestUrl}\n${row.exchange.requestHeaders.map(([name, value]) => `${name}: ${value}`).join('\n')}\n\n${row.exchange.requestBody}`}
                              />
                              <RawData
                                title="Response · status, headers and raw body"
                                text={`HTTP ${row.exchange.httpStatus ?? '(not received)'}\n${row.exchange.responseHeaders.map(([name, value]) => `${name}: ${value}`).join('\n')}\n\n${row.exchange.rawResponse}`}
                              />
                              <RawData
                                title="Reported usage · original fields"
                                text={JSON.stringify(
                                  row.exchange.rawUsage,
                                  null,
                                  2,
                                )}
                              />
                            </>
                          ) : null}
                        </div>
                      </details>
                    ))}
                </div>
              </article>
            );
          })}
          <p className="text-xs leading-5 text-muted-foreground">
            Messages total input includes direct input, cache writes and cache
            reads. Chat Completions and Responses input totals already include
            cached tokens. Missing counters appear as —. Usage warnings do not
            establish injection, model identity or actual billing. Passing these
            text requests does not validate streaming or tool support.
          </p>
        </>
      ) : (
        <div className="grid gap-3 md:grid-cols-3">
          {Object.values(ENDPOINTS).map((endpoint) => (
            <div
              key={endpoint.path}
              className="rounded-xl border border-dashed border-border p-4"
            >
              <h3 className="text-sm font-semibold">{endpoint.label}</h3>
              <p className="mt-2 break-all font-mono text-[11px] text-muted-foreground">
                {endpoint.path}
              </p>
              <p className="mt-3 text-xs text-muted-foreground">
                Waiting for a test
              </p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
