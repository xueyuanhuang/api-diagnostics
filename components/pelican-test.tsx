'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PELICAN_PROMPT, extractAnimationHtml, animationPreviewDocument } from '@/lib/pelican-test';
import { validateBaseUrl } from '@/lib/server/connection';
import { confirmHttpRisk, isInsecureHttp } from '@/lib/http-consent';

type Result = {
  answer?: string;
  error?: string;
  returnedModel?: string;
  outputTokens?: number;
  totalInputTokens?: number;
  totalTimeMs?: number;
};
type SavedResult = { id: string; savedAt: string; model: string; prompt: string; result: Result };
const SAVED_RESULTS_KEY = 'pelican-animation:saved-results:v1';

export function PelicanTest() {
  const [apiType, setApiType] = useState('openai');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [copied, setCopied] = useState(false);
  const [savedResults, setSavedResults] = useState<SavedResult[]>([]);
  const [saveMessage, setSaveMessage] = useState('');
  const [resultModel, setResultModel] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(SAVED_RESULTS_KEY) || '[]');
      if (Array.isArray(stored)) setSavedResults(stored.filter((item): item is SavedResult => Boolean(item && typeof item.id === 'string' && typeof item.model === 'string' && typeof item.savedAt === 'string' && item.result && typeof item.result.answer === 'string')).slice(0, 10));
    } catch { setSaveMessage('Saved results could not be read in this browser.'); }
  }, []);
  const html = extractAnimationHtml(result?.answer ?? '');

  async function start(event: React.FormEvent) {
    event.preventDefault();
    if (controller.current) return;
    setError('');
    const checked = validateBaseUrl(baseUrl.trim());
    if ('error' in checked) { setError(checked.error); return; }
    if (!confirmHttpRisk([baseUrl], (message) => window.confirm(message))) return;
    const abort = new AbortController();
    controller.current = abort;
    setRunning(true);
    setResult(null);
    setSaveMessage('');
    setResultModel(model.trim());
    try {
      const response = await fetch('/api/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testKind: 'pelican', apiType, baseUrl: checked.baseUrl, apiKey: apiKey.trim(), model: model.trim(), allowInsecureHttp: isInsecureHttp(baseUrl) }),
        signal: abort.signal,
      });
      const data = await response.json() as Result;
      if (!response.ok || data.error) throw new Error(data.error || 'The test could not be completed.');
      setResult(data);
      if (!data.answer) setError('The provider returned no visible answer. Try another model.');
    } catch (caught) {
      setError(abort.signal.aborted ? 'Test stopped.' : caught instanceof Error ? caught.message : 'Could not reach the tester. Please try again.');
    } finally {
      controller.current = null;
      setRunning(false);
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'pelican-animation.html';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function saveResult() {
    if (!result?.answer) return;
    // Keep an explicit allowlist: never persist connection keys or raw exchanges.
    const saved: SavedResult = {
      id: crypto.randomUUID(), savedAt: new Date().toISOString(), model: resultModel, prompt: PELICAN_PROMPT,
      result: { answer: result.answer, returnedModel: result.returnedModel, outputTokens: result.outputTokens, totalInputTokens: result.totalInputTokens, totalTimeMs: result.totalTimeMs },
    };
    const next = [saved, ...savedResults].slice(0, 10);
    try {
      localStorage.setItem(SAVED_RESULTS_KEY, JSON.stringify(next));
      setSavedResults(next);
      setSaveMessage('Saved in this browser. Reopen it from Saved results below.');
    } catch { setSaveMessage('Browser storage is unavailable or full. Download the HTML to keep this animation.'); }
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-[1480px] px-4 py-6 sm:px-6 lg:px-10">
        <a href="/" className="text-sm font-semibold text-primary hover:underline">← API Diagnostics</a>
        <header className="my-6 border-b border-border pb-6">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Pelican Animation Test</h1>
          <p className="mt-2 text-base text-muted-foreground">Give a model the same drawing challenge, then see its animation. No sign-in required.</p>
        </header>
        <div className="grid items-start gap-5 lg:grid-cols-[360px_minmax(0,1fr)]">
          <form onSubmit={start} className="space-y-5 rounded-2xl border border-border bg-card p-5 shadow-sm">
            <h2 className="text-lg font-semibold">Your connection</h2>
            <fieldset disabled={running} className="space-y-4">
              <label className="block text-sm font-medium">API format
                <select value={apiType} onChange={event => setApiType(event.target.value)} className="mt-2 h-10 w-full rounded-lg border border-input bg-background px-3 text-sm">
                  <option value="openai">OpenAI-compatible</option>
                  <option value="anthropic">Anthropic-compatible</option>
                </select>
              </label>
              <label className="block text-sm font-medium">Base URL
                <Input className="mt-2 h-10" type="url" required value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://your-provider.com/v1" />
              </label>
              <label className="block text-sm font-medium">API key
                <Input className="mt-2 h-10" type="password" autoComplete="off" required minLength={8} maxLength={512} value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder="Enter your API key" />
              </label>
              <label className="block text-sm font-medium">Model name
                <Input className="mt-2 h-10" required maxLength={120} value={model} onChange={event => setModel(event.target.value)} placeholder="Exact model ID from your provider" />
              </label>
            </fieldset>
            <p className="text-sm leading-6 text-muted-foreground">Your key is sent through this site's relay to your provider for this request. Your key is never saved by this test. Results are saved in this browser only when you choose Save result.</p>
            <p className="text-sm leading-6 text-muted-foreground">One request · up to 8,192 output tokens · 3-minute limit. Your provider may charge for usage.</p>
            <div className="flex gap-2">
              <Button type="submit" disabled={running} className="h-11 flex-1">{running ? 'Generating animation…' : 'Run animation test'}</Button>
              {running && <Button type="button" variant="outline" className="h-11" onClick={() => controller.current?.abort()}>Stop</Button>}
            </div>
            {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
            <div className="border-t border-border pt-4">
              <label className="block text-sm font-medium">Saved results
                <select disabled={running || savedResults.length === 0} value="" onChange={event => {
                  const saved = savedResults.find(item => item.id === event.target.value);
                  if (saved) { setResult(saved.result); setResultModel(saved.model); setError(''); setSaveMessage(`Opened result saved ${new Date(saved.savedAt).toLocaleString()}.`); }
                }} className="mt-2 h-10 w-full rounded-lg border border-input bg-background px-3 text-sm">
                  <option value="">{savedResults.length ? 'Choose a saved result' : 'No saved results yet'}</option>
                  {savedResults.map(saved => <option key={saved.id} value={saved.id}>{saved.model} · {new Date(saved.savedAt).toLocaleString()}</option>)}
                </select>
              </label>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">Keeps the latest 10 results on this device. Clearing browser data removes them; download HTML for a permanent copy.</p>
            </div>
          </form>
          <div className="min-w-0 space-y-5">
            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-lg font-semibold">The prompt</h2>
                <Button variant="outline" onClick={async () => { try { await navigator.clipboard.writeText(PELICAN_PROMPT); setCopied(true); } catch { setError('Could not copy. Select and copy the prompt below.'); } }}>{copied ? 'Copied' : 'Copy prompt'}</Button>
              </div>
              <p lang="zh" className="mt-4 select-text text-base leading-7">{PELICAN_PROMPT}</p>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">Create an HTML page with a 2D SVG animation of a pelican riding a bicycle. No tests needed.</p>
            </section>
            <section className="overflow-hidden rounded-2xl border border-border bg-card">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-5">
                <h2 className="text-lg font-semibold">Animation preview</h2>
                <div className="flex flex-wrap gap-2">
                  {result?.answer && <Button onClick={saveResult}>Save result</Button>}
                  {html && <Button variant="outline" onClick={download}>Download HTML</Button>}
                </div>
              </div>
              {html ? <iframe title="Generated pelican animation" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={animationPreviewDocument(html)} className="h-[540px] w-full border-0 bg-white" /> : <div className="flex min-h-72 items-center justify-center p-8 text-center text-base text-muted-foreground" role="status">{running ? 'The model is drawing. Its animation will appear when the response finishes.' : result?.answer ? 'No HTML or SVG was found. Read the model response below.' : 'Enter your connection and run the test to see what your model creates.'}</div>}
              {html && <p className="border-t border-border px-5 py-3 text-sm text-muted-foreground">Preview is isolated; external resources are blocked. If incomplete, inspect the response below.</p>}
            </section>
            {saveMessage && <p role="status" className="text-sm">{saveMessage}</p>}
            {result && <section className="space-y-4 rounded-2xl border border-border bg-card p-5">
              <p className="break-words text-sm text-muted-foreground">Model: {result.returnedModel || resultModel} · Input: {result.totalInputTokens ?? '—'} tokens · Output: {result.outputTokens ?? '—'} tokens · {result.totalTimeMs == null ? '—' : (result.totalTimeMs / 1000).toFixed(1)} seconds</p>
              {result.outputTokens != null && result.outputTokens >= 8192 && <p role="status" className="text-sm">The output limit was reached; the animation may be incomplete.</p>}
              <details><summary className="cursor-pointer text-base font-semibold">Model response / HTML source</summary><pre className="mt-4 max-h-[500px] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-4 text-sm">{result.answer || 'No visible answer returned.'}</pre></details>
            </section>}
          </div>
        </div>
      </div>
    </main>
  );
}
