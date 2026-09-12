'use client';
import { WorkspaceLink as Link } from '@/components/workspace-navigation';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { chatGPTSignInPath } from '@/lib/auth-paths';
import { animationConnectionLabel, type AnimationResult, type AnimationSummary, type SavedAnimation } from '@/lib/animation-results';
import { Input } from '@/components/ui/input';
import { AnimationPreview } from '@/components/animation-preview';
import { ModelPicker } from '@/components/model-picker';
import { PELICAN_PROMPT, PELICAN_MAX_TOKENS, PELICAN_OUTPUT_CEILING, adjustPelicanOutputLimit, pelicanOutputLimit, extractAnimationHtml, animationWarning } from '@/lib/pelican-test';
import { validateBaseUrl } from '@/lib/server/connection';
import { confirmHttpRisk, isInsecureHttp } from '@/lib/http-consent';
import { activeConnectionId, rememberConnection, connectionRequest, type SavedConnection, type ConnectionApiType } from '@/lib/saved-connections';

type Result = AnimationResult & { savedAnimation?: AnimationSummary | null; saveError?: string | null };

export function PelicanTest({ onRunningChange }: { onRunningChange?: (running: boolean) => void } = {}) {
  const [apiType, setApiType] = useState('openai');
  const [profiles, setProfiles] = useState<SavedConnection[]>([]);
  const [profileId, setProfileId] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [maxOutputTokens, setMaxOutputTokens] = useState<number>(PELICAN_MAX_TOKENS);
  const [outputLimitDraft, setOutputLimitDraft] = useState(String(PELICAN_MAX_TOKENS));
  useEffect(() => { setOutputLimitDraft(String(maxOutputTokens)); }, [maxOutputTokens]);
  const outputLimitChanged = useRef(false);
  const [outputLimitSaving, setOutputLimitSaving] = useState(false);
  const [outputLimitMessage, setOutputLimitMessage] = useState('');
  const [preferencesReady, setPreferencesReady] = useState(false);
  useEffect(() => {
    try {
      const saved = localStorage.getItem('pelican-animation:output-limit:v1');
      const limit = saved === null ? null : pelicanOutputLimit(Number(saved));
      if (limit !== null) setMaxOutputTokens(limit);
    } catch { /* Device preferences are optional. */ }
  }, []);
  const [running, setRunning] = useState(false);
  useEffect(() => { onRunningChange?.(running); }, [running, onRunningChange]);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [copied, setCopied] = useState(false);
  const [savedResults, setSavedResults] = useState<AnimationSummary[]>([]);
  const [saveMessage, setSaveMessage] = useState('');
  const [resultSaved, setResultSaved] = useState(false);
  const [legacyProfileId, setLegacyProfileId] = useState('');
  const [signedIn, setSignedIn] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [legacyResults, setLegacyResults] = useState<SavedAnimation[]>([]);
  const resultId = useRef('');
  async function loadHistory(before?: string) {
    const data = await connectionRequest<{ results: AnimationSummary[]; nextBefore: string | null }>(`/api/animations${before ? `?before=${encodeURIComponent(before)}` : ''}`);
    setSavedResults(current => before ? [...current, ...data.results.filter(item => !current.some(existing => existing.id === item.id))] : data.results);
    setNextBefore(data.nextBefore);
  }
  useEffect(() => {
    try {
      const old: unknown = JSON.parse(localStorage.getItem('pelican-animation:saved-results:v1') || '[]');
      if (Array.isArray(old)) setLegacyResults(old.filter(item => item?.id && item?.result?.answer).slice(0, 10));
    } catch { /* Legacy device-only results are optional. */ }
  }, []);
  const [resultModel, setResultModel] = useState('');
  const controller = useRef<AbortController | null>(null);
  function chooseConnection(id: string, list = profiles) {
    const profile = list.find(item => item.id === id);
    setProfileId(profile?.id ?? '');
    rememberConnection(profile?.id ?? '');
    setApiKey('');
    if (profile) {
      setApiType(profile.defaultApiType);
      setBaseUrl(profile.configs[profile.defaultApiType].baseUrl);
      setModel(profile.configs[profile.defaultApiType].model);
    }
  }
  useEffect(() => {
    let alive = true;
    void connectionRequest<{ user: unknown }>('/api/session').then(async session => {
      if (!alive) return;
      setSignedIn(Boolean(session.user));
      if (!session.user) return;
      await connectionRequest<{ maxOutputTokens: number }>('/api/animation-preferences').then(saved => {
        if (alive && !outputLimitChanged.current && !controller.current) setMaxOutputTokens(saved.maxOutputTokens);
      }).catch(() => {});
      await loadHistory().catch(() => setSaveMessage('Could not load saved animations. Reload to try again.'));
      const data = await connectionRequest<{ profiles: SavedConnection[] }>('/api/profiles');
      if (!alive) return;
      setProfiles(data.profiles);
      const id = activeConnectionId();
      if (data.profiles.some(item => item.id === id)) chooseConnection(id, data.profiles);
    }).catch(() => { if (alive) setError('Could not load saved connections. Use a one-time connection or reload.'); }).finally(() => { if (alive) setPreferencesReady(true); });
    return () => { alive = false; };
  }, []);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    const refresh = () => {
      if (controller.current) return;
      void connectionRequest<{ user: unknown }>('/api/session').then(async session => {
        if (!session.user) return;
        void loadHistory().catch(() => setSaveMessage('Could not refresh saved animations. Try again later.'));
        const data = await connectionRequest<{ profiles: SavedConnection[] }>('/api/profiles');
        // Navigation refresh must never alter a request that started meanwhile.
        if (controller.current) return;
        setProfiles(data.profiles);
        const id = activeConnectionId();
        if (data.profiles.some(item => item.id === id)) chooseConnection(id, data.profiles);
        else if (profileId && !data.profiles.some(item => item.id === profileId)) chooseConnection('');
      }).catch(() => {});
    };
    window.addEventListener('connections-refresh', refresh);
    return () => window.removeEventListener('connections-refresh', refresh);
  }, [profileId]);
  const html = extractAnimationHtml(result?.answer ?? '');
  const warning = result ? animationWarning(html, result) : null;

  async function changeOutputLimit(limit: number) {
    if (pelicanOutputLimit(limit) === null) {
      setOutputLimitMessage('Enter a positive whole number supported by your provider.');
      return;
    }
    setOutputLimitDraft(String(limit));
    outputLimitChanged.current = true;
    setMaxOutputTokens(limit);
    setOutputLimitSaving(true);
    setOutputLimitMessage('Saving output limit…');
    try {
      if (signedIn) await connectionRequest('/api/animation-preferences', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxOutputTokens: limit }),
      });
      try { localStorage.setItem('pelican-animation:output-limit:v1', String(limit)); }
      catch { if (!signedIn) throw new Error('Could not remember this setting on this device.'); }
      setOutputLimitMessage(`Saved. Future tests will use ${limit.toLocaleString('en-US')} tokens until you change it.`);
    } catch (cause) {
      setOutputLimitMessage(cause instanceof Error ? cause.message : 'Could not save the output limit. Please try again.');
    } finally { setOutputLimitSaving(false); }
  }

  async function start(event: React.FormEvent) {
    event.preventDefault();
    if (controller.current || outputLimitSaving || !preferencesReady) return;
    setError('');
    const checked = validateBaseUrl(baseUrl.trim());
    if ('error' in checked) { setError(checked.error); return; }
    if (!confirmHttpRisk([baseUrl], (message) => window.confirm(message))) return;
    const abort = new AbortController();
    controller.current = abort;
    setRunning(true);
    setResult(null);
    setResultSaved(false);
    resultId.current = crypto.randomUUID();
    setSaveMessage('');
    setResultModel(model.trim());
    try {
      outputLimitChanged.current = true;
      if (signedIn) await connectionRequest('/api/animation-preferences', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxOutputTokens }),
      });
      try { localStorage.setItem('pelican-animation:output-limit:v1', String(maxOutputTokens)); } catch { /* Account preference still persists. */ }
      const response = await fetch('/api/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testKind: 'pelican', maxOutputTokens, animationId: resultId.current, apiType, profileId: profileId || undefined, baseUrl: profileId ? undefined : checked.baseUrl, apiKey: profileId ? undefined : apiKey.trim(), model: model.trim(), allowInsecureHttp: isInsecureHttp(baseUrl) }),
        signal: abort.signal,
      });
      const data = await response.json() as Result;
      if (!response.ok || data.error) throw new Error(data.error || 'The test could not be completed.');
      setResult(data);
      if (data.savedAnimation) {
        setSignedIn(true); setResultSaved(true);
        setSavedResults(current => [data.savedAnimation!, ...current.filter(item => item.id !== data.savedAnimation!.id)]);
        setSaveMessage('Saved to your account. Available across devices in Saved results.');
      } else if (data.saveError) setSaveMessage(data.saveError);
      else if (data.answer) setSaveMessage('Sign in before running a test to save results to your account. You can download this HTML now.');
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

  async function saveResult() {
    if (!result?.answer || historyBusy) return;
    setHistoryBusy(true);
    try {
      const data = await connectionRequest<{ saved: AnimationSummary }>('/api/animations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: resultId.current || crypto.randomUUID(), model: resultModel, prompt: PELICAN_PROMPT, result }),
      });
      setResultSaved(true);
      setSavedResults(current => [data.saved, ...current.filter(item => item.id !== data.saved.id)]);
      setSaveMessage('Saved to your account. Available across devices in Saved results.');
    } catch (cause) { setSaveMessage(cause instanceof Error ? cause.message : 'Saving failed. Retry or download the HTML.'); }
    finally { setHistoryBusy(false); }
  }
  async function openSaved(id: string) {
    if (!id || running || historyBusy) return;
    setHistoryBusy(true);
    try {
      const { saved } = await connectionRequest<{ saved: SavedAnimation }>(`/api/animations/${encodeURIComponent(id)}`);
      setLegacyProfileId('');
      setResult(saved.result); setResultModel(saved.model); resultId.current = saved.id;
      setResultSaved(true); setError(''); setSaveMessage(`Opened result saved ${new Date(saved.savedAt).toLocaleString()}.`);
    } catch (cause) { setSaveMessage(cause instanceof Error ? cause.message : 'Could not open result.'); }
    finally { setHistoryBusy(false); }
  }
  async function assignLegacyConnection() {
    if (!legacyProfileId || !resultId.current || historyBusy) return;
    setHistoryBusy(true);
    try {
      const { saved } = await connectionRequest<{ saved: SavedAnimation }>(`/api/animations/${encodeURIComponent(resultId.current)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profileId: legacyProfileId }),
      });
      setResult(saved.result);
      setSavedResults(current => current.map(item => item.id === saved.id ? { ...item, connectionName: saved.result.connectionName, keyHint: saved.result.keyHint } : item));
      setSaveMessage('Connection label saved. The original animation and date are unchanged.');
    } catch (cause) { setSaveMessage(cause instanceof Error ? cause.message : 'Could not save the connection label.'); }
    finally { setHistoryBusy(false); }
  }

  async function importLegacy() {
    setHistoryBusy(true);
    try {
      for (const saved of legacyResults) await connectionRequest('/api/animations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(saved) });
      await loadHistory(); setLegacyResults([]);
      setSaveMessage('Previous browser results copied to your account.');
    } catch { setSaveMessage('Some results could not be imported. Retry to finish; saved results will not be duplicated.'); }
    finally { setHistoryBusy(false); }
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-[1480px] px-4 py-6 sm:px-6 lg:px-10">
        <nav className="flex justify-between gap-4"><Link href="/" className="text-sm font-semibold text-primary hover:underline">← API Diagnostics</Link><Link href="/connections" className="text-sm font-semibold text-primary hover:underline">Manage connections</Link></nav>
        <header className="my-6 border-b border-border pb-6">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Pelican Animation Test</h1>
          <p className="mt-2 text-base text-muted-foreground">Give a model the same drawing challenge, then see its animation. No sign-in required.</p>
        </header>
        <div className="space-y-5">
          <form onSubmit={start} className="space-y-5 rounded-2xl border border-border bg-card p-5 shadow-sm">
            <fieldset disabled={running} className="grid gap-4 md:grid-cols-3">
              <label className="block text-sm font-medium">Connection
                <select value={profileId} onChange={event => chooseConnection(event.target.value)} className="mt-2 h-10 w-full rounded-lg border border-input bg-background px-3 text-sm">
                  <option value="">One-time connection</option>
                  {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                </select>
              </label>
              <label className="block text-sm font-medium">API format
                <select value={apiType} onChange={event => {
                  const type = event.target.value as ConnectionApiType;
                  setApiType(type);
                  const config = profiles.find(item => item.id === profileId)?.configs[type];
                  if (config) { setBaseUrl(config.baseUrl); setModel(config.model); }
                }} className="mt-2 h-10 w-full rounded-lg border border-input bg-background px-3 text-sm">
                  <option value="openai">OpenAI-compatible</option>
                  <option value="anthropic">Anthropic-compatible</option>
                </select>
              </label>
              <div className="block text-sm font-medium">Model name
                {profileId ? <ModelPicker key={`${profileId}:${apiType}`} value={model} onChange={setModel} disabled={running} models={profiles.find(item => item.id === profileId)?.configs[apiType as ConnectionApiType].models ?? []} /> : <Input aria-label="Model name" className="mt-2 h-10" required maxLength={120} value={model} onChange={event => setModel(event.target.value)} placeholder="Exact model ID from your provider" />}
              </div>
            </fieldset>
            {!profileId && <details><summary className="cursor-pointer text-sm font-medium text-primary">One-time connection details</summary><fieldset disabled={running} className="mt-4 grid gap-4 md:grid-cols-2"><label className="block text-sm font-medium">Base URL
                <Input className="mt-2 h-10" type="url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://your-provider.com/v1" />
              </label>
              <label className="block text-sm font-medium">API key
                <Input className="mt-2 h-10" type="password" autoComplete="off" minLength={8} maxLength={512} value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder="Enter your API key" />
              </label>
            </fieldset></details>}
            <p className="text-sm leading-6 text-muted-foreground">Saved connections use your encrypted key through the relay. One-time keys are not saved. Manage URLs, keys, and models on the <Link href="/connections" className="font-semibold text-primary underline">Connections page</Link>.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-sm font-medium">Output limit (tokens)
                <Input type="number" min={1} max={PELICAN_OUTPUT_CEILING} step={1} required disabled={running || outputLimitSaving || !preferencesReady} value={outputLimitDraft} onChange={event => { outputLimitChanged.current = true; setOutputLimitDraft(event.target.value); }} onBlur={() => { if (outputLimitDraft !== String(maxOutputTokens)) void changeOutputLimit(Number(outputLimitDraft)); }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void changeOutputLimit(Number(outputLimitDraft)); } }} className="mt-2 h-10" />
              </label>
              <label className="block text-sm font-medium">Adjust by percentage
                <select value="" disabled={running || outputLimitSaving || !preferencesReady} onChange={event => { if (event.target.value) void changeOutputLimit(adjustPelicanOutputLimit(pelicanOutputLimit(Number(outputLimitDraft)) ?? maxOutputTokens, Number(event.target.value))); }} className="mt-2 h-10 w-full rounded-lg border border-input bg-background px-3 text-sm">
                  <option value="">Increase or decrease…</option>
                  {[-50, -25, -10, 10, 25, 50, 100].map(percent => <option key={percent} value={percent}>{percent > 0 ? '+' : '−'}{Math.abs(percent)}%</option>)}
                </select>
              </label>
            </div>
            <p className="text-sm leading-6 text-muted-foreground">Changes save automatically {signedIn ? 'to your account' : 'on this device'} and apply to future tests until you change them. One request · up to {maxOutputTokens.toLocaleString('en-US')} output tokens · 5-minute limit.</p>
            {outputLimitMessage && <p role="status" className="text-sm text-muted-foreground">{outputLimitMessage}</p>}
            <div className="flex gap-2">
              <Button type="submit" disabled={running || outputLimitSaving || !preferencesReady || outputLimitDraft !== String(maxOutputTokens)} className="h-11 flex-1">{running ? 'Generating animation…' : 'Run animation test'}</Button>
              {running && <Button type="button" variant="outline" className="h-11" onClick={() => controller.current?.abort()}>Stop</Button>}
            </div>
            {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
            <div className="border-t border-border pt-4">
              <label className="block text-sm font-medium">Saved results
                <select disabled={running || historyBusy || savedResults.length === 0} value="" onChange={event => void openSaved(event.target.value)} className="mt-2 h-10 w-full rounded-lg border border-input bg-background px-3 text-sm">
                  <option value="">{savedResults.length ? 'Choose a saved result' : 'No saved results yet'}</option>
                  {savedResults.map(saved => <option key={saved.id} value={saved.id}>{animationConnectionLabel(saved)} · {saved.model} · {new Date(saved.savedAt).toLocaleString()}</option>)}
                </select>
              </label>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">When signed in, successful results save automatically to your account on the server, including while you browse another section. Reopen them on any device.</p>
              {!signedIn && <a href={chatGPTSignInPath('/pelican')} target="_top" className="mt-2 inline-block text-sm font-semibold text-primary underline">Sign in to save results to your account</a>}
              {nextBefore && <Button type="button" variant="outline" disabled={historyBusy} onClick={() => { setHistoryBusy(true); void loadHistory(nextBefore).catch(() => setSaveMessage('Could not load older results.')).finally(() => setHistoryBusy(false)); }}>Load older results</Button>}
              {signedIn && legacyResults.length > 0 && <Button type="button" variant="outline" disabled={historyBusy} onClick={() => void importLegacy()}>Import {legacyResults.length} previous browser results</Button>}
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
                  {result?.answer && signedIn && <Button disabled={resultSaved || historyBusy} onClick={() => void saveResult()}>{resultSaved ? 'Saved to your account' : historyBusy ? 'Saving…' : 'Retry saving'}</Button>}
                  {html && <Button variant="outline" onClick={download}>Download HTML</Button>}
                </div>
              </div>
              {warning && <div role="alert" className="border-b border-amber-200 bg-amber-50 px-5 py-4 text-sm leading-6 text-amber-950"><strong className="block">Incomplete animation response</strong>{warning}</div>}
              {html ? <AnimationPreview key={resultId.current} html={html} /> : <div className="flex min-h-72 items-center justify-center p-8 text-center text-base text-muted-foreground" role="status">{running ? 'The model is drawing. Its animation will appear when the response finishes.' : result?.answer ? 'No HTML or SVG was found. Read the model response below.' : 'Enter your connection and run the test to see what your model creates.'}</div>}
              {html && <p className="border-t border-border px-5 py-3 text-sm text-muted-foreground">Preview is isolated; external resources are blocked. If incomplete, inspect the response below.</p>}
            </section>
            {saveMessage && <p role="status" className="text-sm">{saveMessage}</p>}
            {result && <section className="space-y-4 rounded-2xl border border-border bg-card p-5">
              <p className="break-words text-sm font-medium">Connection: {animationConnectionLabel(result)}</p>
              {signedIn && resultSaved && !result.keyHint && <div className="space-y-3 rounded-lg border border-border p-4">
                <p className="text-sm text-muted-foreground">This older result did not record its key. Choose the connection you used to label it. The original key ending cannot be recovered.</p>
                <label className="block text-sm font-medium">Connection used for this saved result
                  <select disabled={historyBusy || running} value={legacyProfileId} onChange={event => setLegacyProfileId(event.target.value)} className="mt-2 h-10 w-full rounded-lg border border-input bg-background px-3 text-sm">
                    <option value="">Choose the connection used</option>
                    {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                  </select>
                </label>
                <Button disabled={!legacyProfileId || historyBusy || running} onClick={() => void assignLegacyConnection()}>Save connection label</Button>
              </div>}
              <p className="break-words text-sm text-muted-foreground">Model: {result.returnedModel || resultModel} · Input: {result.totalInputTokens ?? '—'} tokens · Output: {result.outputTokens ?? '—'} tokens · {result.totalTimeMs == null ? '—' : (result.totalTimeMs / 1000).toFixed(1)} seconds</p>

              <details><summary className="cursor-pointer text-base font-semibold">Model response / HTML source</summary><pre className="mt-4 max-h-[500px] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-4 text-sm">{result.answer || 'No visible answer returned.'}</pre></details>
            </section>}
          </div>
        </div>
      </div>
    </main>
  );
}
