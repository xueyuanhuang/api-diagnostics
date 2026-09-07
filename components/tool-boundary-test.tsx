'use client';

import { useEffect, useRef, useState } from 'react';
import { Copy, Download, Play, ShieldQuestion, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { confirmHttpRisk, isInsecureHttp } from '@/lib/http-consent';
import {
  BOUNDARY_PROMPT,
  BOUNDARY_REVIEW_LABELS,
  boundaryRequestBody,
  runBoundarySequence,
  type BoundaryApiType,
  type BoundaryExchange,
  type BoundaryReview,
} from '@/lib/tool-boundary';

type Row = {
  status: 'waiting' | 'running' | 'complete' | 'error' | 'stopped';
  exchange: BoundaryExchange | null;
  error: string | null;
  review: BoundaryReview;
};
type Probe = {
  id: string;
  label: string;
  model: string;
  apiType: BoundaryApiType;
  createdAt: string;
  rows: Row[];
};

function RawData({ title, text }: { title: string; text: string }) {
  const [message, setMessage] = useState('');
  return (
    <details className="group rounded-xl border border-border bg-background">
      <summary className="cursor-pointer px-4 py-3 text-xs font-semibold">
        {title}
      </summary>
      <div className="border-t border-border p-3">
        <div className="mb-2 flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(text);
                setMessage('Copied');
              } catch {
                setMessage(
                  'Copy unavailable. Select the text or download JSON.',
                );
              }
            }}
          >
            <Copy className="size-3" /> Copy
          </Button>
          <output className="text-xs text-muted-foreground">{message}</output>
        </div>
        <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted/60 p-3 font-mono text-[11px] leading-5">
          {text || '(empty)'}
        </pre>
      </div>
    </details>
  );
}

export function ToolBoundaryTest(props: {
  apiType: BoundaryApiType;
  baseUrl: string;
  model: string;
  apiKey: string;
  selectedProfileId: string;
  profileName: string;
  profileDirty: boolean;
  startBlocked: boolean;
  onRunningChange: (running: boolean) => void;
}) {
  const [probes, setProbes] = useState<Probe[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [running, setRunning] = useState(false);
  const [formError, setFormError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const probe = probes.find((item) => item.id === selectedId) ?? probes.at(-1);
  useEffect(() => () => controller.current?.abort(), []);

  function updateRow(id: string, index: number, values: Partial<Row>) {
    setProbes((all) =>
      all.map((item) =>
        item.id !== id
          ? item
          : {
              ...item,
              rows: item.rows.map((row, i) =>
                i === index ? { ...row, ...values } : row,
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
        'Save the edited profile first so the probe uses the connection shown.',
      );
      return;
    }
    if (!confirmHttpRisk([props.baseUrl], (message) => window.confirm(message)))
      return;
    let hostname;
    try {
      hostname = new URL(props.baseUrl).host;
    } catch {
      setFormError('Enter a valid provider URL.');
      return;
    }
    const abort = new AbortController();
    controller.current = abort;
    const id = crypto.randomUUID();
    const item: Probe = {
      id,
      label: props.profileName.trim() || hostname,
      model: props.model.trim(),
      apiType: props.apiType,
      createdAt: new Date().toISOString(),
      rows: Array.from({ length: 3 }, () => ({
        status: 'waiting',
        exchange: null,
        error: null,
        review: 'pending',
      })),
    };
    const payload = {
      apiType: props.apiType,
      model: item.model,
      profileId: props.selectedProfileId || undefined,
      baseUrl: props.selectedProfileId ? undefined : props.baseUrl.trim(),
      apiKey: props.selectedProfileId ? undefined : props.apiKey.trim(),
      allowInsecureHttp: isInsecureHttp(props.baseUrl),
    };
    setProbes((all) => [...all, item]);
    setSelectedId(id);
    setRunning(true);
    props.onRunningChange(true);
    try {
      await runBoundarySequence<{
        exchange?: BoundaryExchange;
        error?: string;
      }>({
        signal: abort.signal,
        onStart: (index) => updateRow(id, index, { status: 'running' }),
        request: async (_index, signal) => {
          const response = await fetch('/api/tool-boundary', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
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
          updateRow(id, index, {
            status: failure || exchange?.issues.length ? 'error' : 'complete',
            exchange,
            error: failure,
          });
        },
      });
    } finally {
      setProbes((all) =>
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
                            ? 'Stopped. The active request may have reached the provider; its response was not captured.'
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
    if (!probe) return;
    const data = {
      format: 'tool-boundary-v1',
      captureNotes:
        'Application-level HTTP evidence, not a wire capture. Transport-added headers are not recorded. API keys and sensitive response headers are redacted. Response text is unchanged otherwise, including reasoning/signature fields. Captures exceeding 2 MiB or interrupted by a timeout are explicitly marked partial. Review labels are manual assessments of self-description, not proof of injection or execution.',
      prompt: BOUNDARY_PROMPT,
      repeats: 3,
      intervalAfterCompletionMs: 3000,
      providerTimeoutMs: 120000,
      ...probe,
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `tool-boundary-${probe.id}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <section className="space-y-5" aria-label="Tool Boundary Probe">
      <div className="rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-xl">
            <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              <ShieldQuestion className="size-4" /> Tool boundary
            </div>
            <h2 className="text-xl font-semibold tracking-tight">
              What tools does the model claim to have?
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Ask the same question three times in fresh requests. Compare the
              answers and inspect exactly what the relay sent and received.
            </p>
          </div>
          <Badge variant="outline">3 serial requests</Badge>
        </div>
        <blockquote
          className="my-5 rounded-xl border-l-4 border-primary bg-muted/50 p-4 text-sm leading-7"
          lang="zh-CN"
        >
          {BOUNDARY_PROMPT}
        </blockquote>
        <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
          {[
            'No tools or system message',
            'No conversation history',
            'Sampling defaults',
            '8,192 output-token limit',
            '3s between requests',
            '120s timeout each',
          ].map((label) => (
            <span
              key={label}
              className="rounded-md border border-border px-2 py-1"
            >
              {label}
            </span>
          ))}
        </div>
        <details className="mt-4 text-xs text-muted-foreground">
          <summary className="cursor-pointer font-medium">
            Preview the request body
          </summary>
          <pre className="mt-2 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted/60 p-3 font-mono text-[11px] leading-5">
            {JSON.stringify(
              boundaryRequestBody(
                props.apiType,
                props.model.trim() || 'YOUR_MODEL',
              ),
              null,
              2,
            )}
          </pre>
        </details>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Button
            type="button"
            disabled={running || props.startBlocked}
            onClick={() => void start()}
            className="h-10 bg-[#f3a712] text-[#172033] hover:bg-[#e99a02]"
          >
            <Play className="size-4" />
            {running ? 'Probe running…' : 'Run tool-boundary probe'}
          </Button>
          {running && (
            <Button
              type="button"
              variant="outline"
              onClick={() => controller.current?.abort()}
            >
              <Square className="size-3" /> Stop
            </Button>
          )}
          <span className="text-xs text-muted-foreground">
            {props.apiType === 'openai' ? 'Chat Completions' : 'Messages'} ·
            current connection
          </span>
        </div>
        {formError && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {formError}
          </p>
        )}
        <p className="mt-4 text-xs leading-5 text-muted-foreground">
          Self-description alone does not prove tool access, execution or prompt
          injection. Review each answer in context. Results stay in this tab;
          download the evidence before closing it.
        </p>
      </div>

      {probe && (
        <>
          <div className="flex flex-wrap items-end justify-between gap-3 rounded-xl border border-border bg-card p-4">
            <label className="min-w-0 flex-1 space-y-2 text-xs font-medium">
              Probes in this tab
              <select
                value={probe.id}
                onChange={(event) => setSelectedId(event.target.value)}
                className="block h-10 w-full min-w-0 rounded-lg border border-input bg-background px-3 text-xs"
              >
                {probes.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label} · {item.model} ·{' '}
                    {item.apiType === 'openai' ? 'Chat' : 'Messages'} ·{' '}
                    {new Date(item.createdAt).toLocaleTimeString()}
                  </option>
                ))}
              </select>
            </label>
            <Button type="button" variant="outline" onClick={download}>
              <Download className="size-4" /> Download raw JSON
            </Button>
          </div>
          <div
            className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
            aria-live="polite"
          >
            {(['denies', 'claims', 'unclear', 'pending'] as const).map(
              (review) => (
                <div
                  key={review}
                  className="rounded-xl border border-border bg-card p-4"
                >
                  <p className="text-2xl font-semibold">
                    {probe.rows.filter((row) => row.review === review).length}
                    <span className="text-sm font-normal text-muted-foreground">
                      {' '}
                      / 3
                    </span>
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {review === 'pending'
                      ? 'Not assessed / not reviewed'
                      : BOUNDARY_REVIEW_LABELS[review]}
                  </p>
                </div>
              ),
            )}
          </div>
          {probe.rows.map((row, index) => {
            const exchange = row.exchange;
            return (
              <article
                key={`${probe.id}-${index}`}
                className="space-y-4 rounded-2xl border border-border bg-card p-5 shadow-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold">
                    Request {index + 1}{' '}
                    <span className="ml-2 font-normal text-muted-foreground">
                      {probe.model}
                    </span>
                  </h3>
                  <Badge variant="outline">
                    {row.status === 'complete'
                      ? 'Response captured · review needed'
                      : row.status === 'error'
                        ? 'Response abnormal · cannot assess'
                        : row.status === 'running'
                          ? 'Waiting for response…'
                          : row.status === 'waiting'
                            ? 'Waiting'
                            : 'Stopped'}
                  </Badge>
                </div>
                {row.error && (
                  <p role="alert" className="text-sm text-destructive">
                    {row.error}
                  </p>
                )}
                {exchange && (
                  <>
                    <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
                      <span>HTTP {exchange.httpStatus ?? '—'}</span>
                      <span>{(exchange.totalTimeMs / 1000).toFixed(2)}s</span>
                      <span>
                        Finish: {exchange.finishReasons.join(', ') || '—'}
                      </span>
                      <span>
                        Raw capture:{' '}
                        {exchange.captureComplete
                          ? 'complete'
                          : 'partial / unavailable'}
                      </span>
                    </div>
                    {exchange.issues.length > 0 && (
                      <ul className="list-inside list-disc text-xs leading-6 text-destructive">
                        {exchange.issues.map((issue, i) => (
                          <li key={i}>{issue}</li>
                        ))}
                      </ul>
                    )}
                    <div className="rounded-xl bg-muted/45 p-4">
                      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Answer
                      </p>
                      <p className="whitespace-pre-wrap break-words text-sm leading-7">
                        {exchange.answer || '(No text answer)'}
                      </p>
                    </div>
                    <p className="text-xs leading-5">
                      <strong>Structured tool-call requests:</strong>{' '}
                      {exchange.structuredToolCalls.length
                        ? `${exchange.structuredToolCalls.length} returned — inspect raw response. This is not proof of execution.`
                        : exchange.captureComplete && !exchange.issues.length
                          ? 'None returned.'
                          : 'None detected in the captured data; response cannot be fully assessed.'}
                    </p>
                    <label className="block space-y-2 text-xs font-medium">
                      Your review of the answer
                      <select
                        aria-label={`Review request ${index + 1}`}
                        value={row.review}
                        disabled={row.status !== 'complete'}
                        onChange={(event) =>
                          updateRow(probe.id, index, {
                            review: event.target.value as BoundaryReview,
                          })
                        }
                        className="block h-10 w-full rounded-lg border border-input bg-background px-3 text-xs disabled:opacity-50"
                      >
                        {Object.entries(BOUNDARY_REVIEW_LABELS).map(
                          ([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ),
                        )}
                      </select>
                    </label>
                    <div className="space-y-2">
                      <RawData
                        title="Raw request · method, URL, headers and body"
                        text={`${exchange.requestMethod} ${exchange.requestUrl}\n${exchange.requestHeaders.map(([name, value]) => `${name}: ${value}`).join('\n')}\n\n${exchange.requestBody}`}
                      />
                      <RawData
                        title="Raw response · status, headers and complete captured body"
                        text={`HTTP ${exchange.httpStatus ?? '(no response)'}\n${exchange.responseHeaders.map(([name, value]) => `${name}: ${value}`).join('\n')}\n\n${exchange.rawResponse}`}
                      />
                      <RawData
                        title="All captured fields · timestamps, IDs and assessment"
                        text={JSON.stringify(row, null, 2)}
                      />
                    </div>
                  </>
                )}
              </article>
            );
          })}
          <p className="text-xs leading-5 text-muted-foreground">
            Raw views and downloads preserve returned fields, including
            reasoning signatures. API keys and sensitive headers are redacted.
            These are application-level captures; headers added by the network
            runtime are not recorded. Responses over 2 MiB are marked partial.
          </p>
        </>
      )}
    </section>
  );
}
