'use client';

import { useEffect, useRef, useState } from 'react';
import { Download, Play, Square } from 'lucide-react';
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
  type ToolChoiceRow,
  type ToolChoiceRun,
} from '@/lib/diagnostic-runs';
import {
  toolChoiceRequestBody,
  TOOL_CHOICE_MODES,
  type ToolChoiceApiType,
  type ToolChoiceExchange,
} from '@/lib/tool-choice';
import { openRouterRoute } from '@/lib/openrouter';
import { confirmHttpRisk, isInsecureHttp } from '@/lib/http-consent';

const verdictLabels = {
  pass: 'Passed · no tool calls',
  fail: 'Failed · none was not respected',
  inconclusive: 'Inconclusive · inspect evidence',
};

export function ToolChoiceTest(props: {
  apiType: ToolChoiceApiType;
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
  savedRun?: ToolChoiceRun;
}) {
  const [runs, setRuns] = useState<ToolChoiceRun[]>(
    props.savedRun ? [props.savedRun] : [],
  );
  const [selectedId, setSelectedId] = useState('');
  const [running, setRunning] = useState(false);
  const [formError, setFormError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const run = runs.find((item) => item.id === selectedId) ?? runs.at(-1);
  const history = useDiagnosticHistory(
    runs,
    Boolean(props.signedIn && !props.savedRun),
    props.onSaved,
  );
  useEffect(() => () => controller.current?.abort(), []);

  function updateRow(
    id: string,
    index: number,
    update: Partial<ToolChoiceRow>,
  ) {
    setRuns((all) =>
      all.map((item) =>
        item.id === id
          ? {
              ...item,
              rows: item.rows.map((row, i) =>
                i === index ? { ...row, ...update } : row,
              ),
            }
          : item,
      ),
    );
  }
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
    if (props.selectedProfileId && props.profileDirty) {
      setFormError('Save the edited connection before starting.');
      return;
    }
    if (!confirmHttpRisk([props.baseUrl], (message) => window.confirm(message)))
      return;
    let hostname: string;
    try {
      hostname = new URL(props.baseUrl).host;
    } catch {
      setFormError('Enter a valid provider URL.');
      return;
    }
    const abort = new AbortController();
    controller.current = abort;
    const item: ToolChoiceRun = {
      id: crypto.randomUUID(),
      testKind: 'tool-choice',
      apiType: props.apiType,
      baseUrl: props.baseUrl.trim(),
      model: props.model.trim(),
      profileId: props.selectedProfileId || null,
      label: `${props.profileName.trim() || hostname}${props.openRouterTier ? ` · ${props.openRouterTier === 'flex' ? 'Flex' : 'Standard'} requested` : ''}`,
      createdAt: new Date().toISOString(),
      rows: TOOL_CHOICE_MODES.map((stream) => ({
        stream,
        status: 'waiting',
        exchange: null,
        error: null,
      })),
    };
    const payload = {
      apiType: props.apiType,
      model: item.model,
      openRouterTier: props.openRouterTier,
      profileId: props.selectedProfileId || undefined,
      baseUrl: props.selectedProfileId ? undefined : props.baseUrl.trim(),
      apiKey: props.selectedProfileId ? undefined : props.apiKey.trim(),
      allowInsecureHttp: isInsecureHttp(props.baseUrl),
    };
    setRuns((all) => [...all, item]);
    setSelectedId(item.id);
    setRunning(true);
    props.onRunningChange(true);
    try {
      for (const [index, stream] of TOOL_CHOICE_MODES.entries()) {
        if (abort.signal.aborted) break;
        updateRow(item.id, index, { status: 'running' });
        try {
          const response = await fetch('/api/tool-choice', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...payload, stream }),
            signal: abort.signal,
          });
          let data: { exchange?: ToolChoiceExchange; error?: string };
          try {
            data = await response.json();
          } catch {
            throw new Error(
              `The tester returned unreadable data (HTTP ${response.status}). No provider result was confirmed.`,
            );
          }
          if (!response.ok || !data.exchange)
            throw new Error(
              data.error ||
                `The tester could not capture a response (HTTP ${response.status}).`,
            );
          updateRow(item.id, index, {
            status: data.exchange.verdict === 'pass' ? 'pass' : 'issue',
            exchange: data.exchange,
            error: null,
          });
        } catch (error) {
          if (abort.signal.aborted) break;
          updateRow(item.id, index, {
            status: 'issue',
            error:
              error instanceof Error
                ? error.message
                : 'Request failed; no provider response was captured.',
          });
        }
      }
    } finally {
      setRuns((all) =>
        all.map((saved) =>
          saved.id !== item.id
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
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(diagnosticExport(run), null, 2)], {
        type: 'application/json',
      }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `tool-choice-${run.id}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  let route = null;
  try {
    route = openRouterRoute(
      props.baseUrl,
      props.apiType,
      props.model,
      props.openRouterTier,
    );
  } catch {
    /* The server validates the selected route before sending. */
  }
  return (
    <section aria-label="Tool Choice Test" className="space-y-5">
      {!props.savedRun && (
        <div className="space-y-4 rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold">
                Does “none” prevent tool calls?
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                Provide a weather tool, then explicitly forbid tool calls. Check
                whether the response respects that setting, even when the API
                returns HTTP 200.
              </p>
            </div>
            <Badge variant="outline">2 requests · none</Badge>
          </div>
          <div className="rounded-xl bg-muted/50 p-4 text-sm leading-6">
            <p>
              <strong>Expected:</strong> an ordinary text response with no
              tool-call instructions.
            </p>
            <p>
              <strong>Failed:</strong> a structured tool call appears despite{' '}
              <code>none</code>.
            </p>
            <p>
              <strong>Inconclusive:</strong> an API error, incomplete response,
              or unexpected response format prevents a clean assessment.
            </p>
          </div>
          <RawData
            title="Request preview · tool definition + none (not sent yet)"
            text={JSON.stringify(
              {
                ...toolChoiceRequestBody(props.apiType, props.model, false),
                ...route,
              },
              null,
              2,
            )}
          />
          <p className="text-xs leading-5 text-muted-foreground">
            Uses{' '}
            {props.apiType === 'openai'
              ? 'Chat Completions with tool_choice: "none"'
              : 'Messages with tool_choice: {"type":"none"}'}{' '}
            and the selected connection and resource. Runs once without
            streaming, then once with streaming. Up to 4,096 output tokens and
            120 seconds per request. Provider usage may be charged. The tester
            never executes the declared function.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              onClick={() => void start()}
              disabled={running || props.startBlocked}
            >
              <Play className="size-4" />
              Start tool-choice test
            </Button>
            {running && (
              <Button
                type="button"
                variant="outline"
                onClick={() => controller.current?.abort()}
              >
                <Square className="size-4" />
                Stop test
              </Button>
            )}
            <output className="text-xs text-muted-foreground">
              {running
                ? 'Checking responses…'
                : run
                  ? 'Results below.'
                  : 'Ready to test.'}
            </output>
          </div>
          {formError && (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          )}
        </div>
      )}
      {run && (
        <>
          {!props.savedRun && (
            <DiagnosticHistorySave
              signedIn={Boolean(props.signedIn)}
              status={history.statuses[run.id]}
              retry={() => history.retry(run.id)}
            />
          )}
          <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card p-4">
            <label className="min-w-0 flex-1 space-y-2 text-xs font-medium">
              {props.savedRun ? 'Saved test' : 'Tests in this tab'}
              <select
                aria-label="Tool-choice run"
                className="block h-10 w-full min-w-0 rounded-lg border border-input bg-background px-3 text-xs"
                value={run.id}
                onChange={(e) => setSelectedId(e.target.value)}
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
              <Download className="size-4" />
              Download evidence
            </Button>
          </div>
          {run.rows.map((row, index) => {
            const e = row.exchange;
            const verdict = e?.verdict;
            return (
              <article
                key={`${run.id}-${index}`}
                className="space-y-4 rounded-2xl border border-border bg-card p-5 shadow-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h3 className="font-semibold">
                    {row.stream
                      ? 'Streaming response'
                      : 'Non-streaming response'}
                  </h3>
                  <Badge
                    variant="outline"
                    className={
                      verdict === 'fail'
                        ? 'border-red-300 bg-red-50 text-red-800'
                        : verdict === 'pass'
                          ? 'border-green-300 bg-green-50 text-green-800'
                          : ''
                    }
                  >
                    {row.status === 'stopped'
                      ? 'Stopped'
                      : verdict
                        ? verdictLabels[verdict]
                        : row.status === 'running'
                          ? 'Waiting for response…'
                          : row.status === 'waiting'
                            ? 'Not started'
                            : verdictLabels.inconclusive}
                  </Badge>
                </div>
                {row.error && (
                  <p role="alert" className="text-sm text-destructive">
                    {row.error}
                  </p>
                )}
                {e && (
                  <>
                    <p className="break-all text-xs text-muted-foreground">
                      {run.model} · HTTP {e.httpStatus ?? '—'} ·{' '}
                      {(e.totalTimeMs / 1000).toFixed(2)} s · Capture{' '}
                      {e.captureComplete ? 'complete' : 'partial'} · Finish:{' '}
                      {e.finishReasons.join(', ') || 'not confirmed'}
                    </p>
                    <div
                      className={`rounded-xl p-4 text-sm leading-6 ${verdict === 'fail' ? 'bg-red-50 text-red-900' : 'bg-muted/50'}`}
                    >
                      <strong>
                        {e.toolCallEvidence.length
                          ? 'Tool-call instructions were returned despite none.'
                          : verdict === 'pass'
                            ? 'No tool-call instructions in this complete response.'
                            : 'No tool-call instructions detected in the captured data; the result is inconclusive.'}
                      </strong>
                      <p>
                        {e.toolCallEvidence.length
                          ? 'Inspect the exact fields below. This shows a returned instruction, not proof that a tool ran.'
                          : 'Ordinary text mentioning tools is not counted as a tool call.'}
                      </p>
                    </div>
                    {e.toolCallEvidence.length > 0 && (
                      <RawData
                        title="Returned tool-call fields · exact evidence"
                        text={JSON.stringify(e.toolCallEvidence, null, 2)}
                      />
                    )}
                    {e.issues.length > 0 && (
                      <ul className="list-inside list-disc text-xs leading-6 text-destructive">
                        {e.issues.map((issue, i) => (
                          <li key={i}>{issue}</li>
                        ))}
                      </ul>
                    )}
                    <div className="grid min-w-0 gap-3 xl:grid-cols-2">
                      <div className="min-w-0">
                        <RawData
                          title="Sent request · actual tool definition and tool_choice"
                          text={`${e.requestMethod} ${e.requestUrl}\n${e.requestHeaders.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${e.requestBody}`}
                        />
                      </div>
                      <div className="min-w-0">
                        <RawData
                          title="Received response · raw body and headers"
                          text={`HTTP ${e.httpStatus ?? '(no response)'}\n${e.responseHeaders.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${e.rawResponse}`}
                        />
                      </div>
                    </div>
                  </>
                )}
              </article>
            );
          })}
          <p className="text-xs leading-6 text-muted-foreground">
            A pass describes this response only; it does not prove the parameter
            was forwarded or that every request will comply. Failures do not
            identify which relay or provider layer caused the problem. Raw
            evidence preserves the captured JSON or stream, with API keys and
            sensitive headers redacted. Responses above 2 MiB are marked
            partial.
          </p>
        </>
      )}
    </section>
  );
}
