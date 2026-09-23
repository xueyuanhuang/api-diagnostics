'use client';
import { useState } from 'react';
type Report = {
  analysisVersion: string;
  results: Array<{
    questionId: string;
    completion: string;
    capture: string;
    cache: string;
    inputSize: string;
    usageAvailability: string;
    protocolFindings: string[];
    issues: string[];
  }>;
  comparison?: {
    verdict: string;
    coverage: string;
    observations: Array<{
      prompt: string;
      identicalText: boolean;
      currentCharacters: number;
      referenceCharacters: number;
      inputTokenDifference: number | null;
    }>;
    limitations: string[];
  } | null;
};
function ReportView({ value }: { value: unknown }) {
  if (Array.isArray(value))
    return (
      <div>
        {value.length ? (
          value.map((entry, i) => (
            <details key={i}>
              <summary>{new Date(entry.createdAt).toLocaleString()}</summary>
              <ReportView value={entry.report} />
            </details>
          ))
        ) : (
          <p>No previous reviews.</p>
        )}
      </div>
    );
  const r = value as Report;
  return (
    <div className="space-y-3 text-sm">
      <p>Analysis version: {r.analysisVersion}</p>
      {r.comparison && (
        <div>
          <strong>{r.comparison.verdict}</strong>
          <p>{r.comparison.coverage}</p>
          {r.comparison.limitations.map((line) => (
            <p key={line} className="text-muted-foreground text-xs">
              {line}
            </p>
          ))}
          <ul>
            {r.comparison.observations.map((o, i) => (
              <li key={i} className="my-2">
                {o.prompt}:{' '}
                {o.identicalText ? 'Identical text' : 'Different text'} ·{' '}
                {o.currentCharacters} vs {o.referenceCharacters} characters ·
                Reported input difference: {o.inputTokenDifference ?? 'unknown'}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="overflow-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr>
              {[
                'Question',
                'Completion / capture',
                'Usage',
                'Input size',
                'Cache observation',
                'Findings',
              ].map((h) => (
                <th key={h} className="p-2">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {r.results.map((q) => (
              <tr key={q.questionId} className="border-t">
                <td className="p-2">{q.questionId}</td>
                <td>
                  {q.completion} / {q.capture}
                </td>
                <td>{q.usageAvailability}</td>
                <td>{q.inputSize}</td>
                <td>{q.cache}</td>
                <td>
                  {[...q.issues, ...q.protocolFindings].join('; ') ||
                    'None detected'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
type Run = {
  id: string;
  modelName: string;
  createdAt: number;
  profileName?: string | null;
  testKind?: string;
};
export function EvidenceReviewPanel({ runs }: { runs: Run[] }) {
  const [selected, setSelected] = useState(''),
    [reference, setReference] = useState(''),
    [report, setReport] = useState<unknown>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const normal = runs.filter((r) => !r.testKind || r.testKind === 'normal');
  const label = (r: Run) =>
    `${r.modelName} · ${r.profileName || 'One-time connection'} · ${new Date(r.createdAt).toLocaleString()}`;
  async function review(history = false) {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(
        `/api/runs/${encodeURIComponent(selected)}/assessments`,
        history
          ? { cache: 'no-store' }
          : {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ referenceRunId: reference || undefined }),
            },
      );
      const data = (await res.json()) as {
        error?: string;
        assessments?: unknown;
        report?: unknown;
      };
      if (!res.ok) throw new Error(data.error);
      setReport(history ? data.assessments : data.report);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Review failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="rounded-2xl border bg-card p-5 my-4">
      <summary className="cursor-pointer font-semibold">
        Review saved evidence & compare behavior
      </summary>
      <p className="text-sm text-muted-foreground my-3">
        Recheck saved Normal Token Check results without making paid requests.
        Each review is saved separately; original results stay unchanged. A
        reference is your selected saved run, not proof of model identity.
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        <label>
          Saved run
          <select
            className="w-full rounded-lg border p-2"
            value={selected}
            onChange={(e) => {
              setSelected(e.target.value);
              setReport(null);
            }}
          >
            <option value="">Choose a saved run</option>
            {normal.map((r) => (
              <option key={r.id} value={r.id}>
                {label(r)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Reference run (optional)
          <select
            className="w-full rounded-lg border p-2"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          >
            <option value="">Reanalyse only</option>
            {normal
              .filter((r) => r.id !== selected)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {label(r)}
                </option>
              ))}
          </select>
        </label>
      </div>
      <p className="text-xs text-muted-foreground my-3">
        Experimental comparison requires matching prompts, API format and
        settings, and at least six confirmed completed answers. Older records
        may have insufficient evidence.
      </p>
      <button
        className="rounded-lg bg-primary text-primary-foreground px-3 py-2 mr-3"
        disabled={!selected || busy}
        onClick={() => review()}
      >
        {busy ? 'Reading evidence…' : 'Save new review'}
      </button>
      <button disabled={!selected || busy} onClick={() => review(true)}>
        Previous reviews
      </button>
      {error && (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      )}
      {report != null && (
        <>
          <p className="mt-3 text-sm">
            Review saved on your account. Comparison does not certify a model or
            its upstream source.
          </p>
          <button
            className="underline my-2"
            onClick={() => {
              const url = URL.createObjectURL(
                new Blob([JSON.stringify(report, null, 2)], {
                  type: 'application/json',
                }),
              );
              const a = document.createElement('a');
              a.href = url;
              a.download = 'evidence-review.json';
              a.click();
              URL.revokeObjectURL(url);
            }}
          >
            Download review
          </button>
          <ReportView value={report} />
        </>
      )}
    </details>
  );
}
