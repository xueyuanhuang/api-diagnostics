'use client';
import Link from 'next/link';
import { ConnectionModels } from '@/components/connection-models';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { chatGPTSignInPath } from '@/lib/auth-paths';
import { activeConnectionId, rememberConnection, connectionRequest, type SavedConnection, type ConnectionApiType } from '@/lib/saved-connections';

export function ConnectionManager() {
  const [loading, setLoading] = useState(true);
  const [signedIn, setSignedIn] = useState(false);
  const [profiles, setProfiles] = useState<SavedConnection[]>([]);
  const [editing, setEditing] = useState('');
  const [activeId, setActiveId] = useState('');
  const [name, setName] = useState('');
  const [apiType, setApiType] = useState<ConnectionApiType>('openai');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [models, setModels] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const profile = profiles.find(item => item.id === editing);
  useEffect(() => {
    const refresh = () => {
      if (!signedIn || busy) return;
      void connectionRequest<{ profiles: SavedConnection[] }>('/api/profiles').then(data => {
        setProfiles(data.profiles); setActiveId(activeConnectionId());
      }).catch(cause => setError(cause.message));
    };
    window.addEventListener('connections-refresh', refresh);
    return () => window.removeEventListener('connections-refresh', refresh);
  }, [signedIn, busy]);

  useEffect(() => {
    let alive = true;
    void connectionRequest<{ user: unknown }>('/api/session').then(async session => {
      if (!alive) return;
      setSignedIn(Boolean(session.user));
      if (!session.user) return;
      const data = await connectionRequest<{ profiles: SavedConnection[] }>('/api/profiles');
      if (alive) { setProfiles(data.profiles); setActiveId(activeConnectionId()); }
    }).catch(cause => { if (alive) setError(cause.message); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  function edit(item?: SavedConnection, type = item?.defaultApiType ?? 'openai') {
    setEditing(item?.id ?? ''); setName(item?.name ?? ''); setApiType(type);
    const config = item?.configs[type];
    setBaseUrl(config?.baseUrl ?? ''); setModel(config?.model ?? '');
    setModels(config?.models.filter(value => value !== config.model).join('\n') ?? '');
    setApiKey(''); setError(''); setMessage('');
  }
  function useConnection(item: SavedConnection) {
    rememberConnection(item.id); setActiveId(item.id);
    setMessage(`${item.name} is selected for all tests on this browser.`);
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const payload = { name, apiType, baseUrl, apiKey, models: [...new Set([model.trim(), ...models.split(/[\n,]/).map(value => value.trim())].filter(Boolean))] };
      const data = await connectionRequest<{ profile: SavedConnection }>(editing ? `/api/profiles/${encodeURIComponent(editing)}` : '/api/profiles', {
        method: editing ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      setProfiles(current => [data.profile, ...current.filter(item => item.id !== data.profile.id)]);
      edit(data.profile); useConnection(data.profile);
      setMessage('Connection saved and selected for all tests. Your API key is encrypted.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save connection.'); }
    finally { setBusy(false); }
  }
  async function remove(item: SavedConnection) {
    if (!window.confirm(`Delete “${item.name}” and its saved API keys? Existing availability monitors using it will also be removed.`)) return;
    setBusy(true); setError('');
    try {
      await connectionRequest(`/api/profiles/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      setProfiles(current => current.filter(value => value.id !== item.id));
      if (activeId === item.id) { rememberConnection(''); setActiveId(''); }
      if (editing === item.id) edit();
      setMessage('Connection deleted.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not delete connection.'); }
    finally { setBusy(false); }
  }

  return <main className="min-h-screen bg-background text-foreground"><div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
    <nav className="flex flex-wrap gap-5 text-sm font-semibold text-primary"><Link href="/" className="hover:underline">← All tests</Link><Link href="/pelican" className="hover:underline">Pelican Animation Test</Link></nav>
    <header className="my-6 border-b border-border pb-6"><h1 className="text-3xl font-semibold">Connections</h1><p className="mt-3 text-base text-muted-foreground">Manage base URLs, API keys, and models in one place. Saved connections are available in every test.</p></header>
    {loading ? <p role="status">Loading your connections…</p> : !signedIn ? <section className="rounded-2xl border border-border bg-card p-6"><h2 className="text-xl font-semibold">Keep your connections in your account</h2><p className="my-4 text-base leading-7">Sign in to save encrypted API keys and reuse connections across tests and devices. Your connections are private to your account. You can still run one-time tests without signing in.</p><a className="inline-flex rounded-lg bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground" href={chatGPTSignInPath('/connections')} target="_top">Sign in with Google</a></section> : <div className="grid items-start gap-6 lg:grid-cols-2">
      <section className="space-y-4"><div className="flex items-center justify-between"><h2 className="text-xl font-semibold">Saved connections</h2><Button disabled={busy} variant="outline" onClick={() => edit()}>New connection</Button></div>
        {profiles.length === 0 && <p className="rounded-2xl border border-dashed border-border p-6 text-muted-foreground">No connections yet. Add your provider details to get started.</p>}
        {profiles.map(item => <article key={item.id} className="space-y-3 rounded-2xl border border-border bg-card p-5"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-lg font-semibold">{item.name}</h3>{activeId === item.id && <span className="rounded-full bg-accent px-3 py-1 text-sm">Selected for tests</span>}</div><p className="break-all text-sm text-muted-foreground">{item.configs[item.defaultApiType].baseUrl}</p><p className="break-words text-sm">{item.defaultApiType === 'openai' ? 'OpenAI-compatible' : 'Anthropic-compatible'} · {item.configs[item.defaultApiType].model}</p><p className="text-sm text-muted-foreground">API key encrypted and saved</p><div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={() => useConnection(item)}>Use for all tests</Button><Button disabled={busy} variant="outline" onClick={() => edit(item)}>Edit</Button><Button disabled={busy} variant="ghost" onClick={() => remove(item)}>Delete</Button></div><ConnectionModels profile={item} disabled={busy} onBusyChange={setBusy} onSaved={(type, savedModels) => {
          setProfiles(current => current.map(profile => profile.id === item.id ? { ...profile, configs: { ...profile.configs, [type]: { ...profile.configs[type], models: savedModels } } } : profile));
          if (editing === item.id && apiType === type) setModels(current => [...new Set([...current.split(/[\n,]/).map(value => value.trim()), ...savedModels])].filter(value => value && value !== model).join('\n'));
        }} /></article>)}
      </section>
      <form onSubmit={save} className="space-y-5 rounded-2xl border border-border bg-card p-5"><h2 className="text-xl font-semibold">{editing ? 'Edit connection' : 'New connection'}</h2><fieldset disabled={busy} className="space-y-4">
        <label className="block text-sm font-medium">Connection name<Input className="mt-2 h-10" required maxLength={60} value={name} onChange={event => setName(event.target.value)} placeholder="e.g. My model provider" /></label>
        <label className="block text-sm font-medium">API format<select className="mt-2 h-10 w-full rounded-lg border border-input bg-background px-3" value={apiType} onChange={event => { const type = event.target.value as ConnectionApiType; if (profile) edit(profile, type); else setApiType(type); }}><option value="openai">OpenAI-compatible</option><option value="anthropic">Anthropic-compatible</option></select></label>
        {editing && <p className="text-sm text-muted-foreground">Edit each format separately. Save changes before switching formats. Saving makes this format the default for the connection.</p>}
        <label className="block text-sm font-medium">Base URL<Input className="mt-2 h-10" type="url" required value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://your-provider.com/v1" /></label>
        <label className="block text-sm font-medium">API key<Input className="mt-2 h-10" type="password" autoComplete="new-password" required={!editing} minLength={8} maxLength={512} value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder={editing ? 'Leave blank to keep the saved key' : 'Enter your API key'} /></label>
        <label className="block text-sm font-medium">Default model<Input className="mt-2 h-10" required maxLength={120} value={model} onChange={event => setModel(event.target.value)} placeholder="Exact model name" /></label>
        <label className="block text-sm font-medium">Other models (optional)<textarea className="mt-2 min-h-24 w-full rounded-lg border border-input bg-background p-3 text-sm" value={models} onChange={event => setModels(event.target.value)} placeholder="One model per line" /></label>
      </fieldset><p className="text-sm leading-6 text-muted-foreground">Keys are encrypted on the server and never shown back in your browser. All tests use the same saved connection list.</p><Button className="h-11" disabled={busy} type="submit">{busy ? 'Saving…' : 'Save connection'}</Button></form>
    </div>}
    {error && <p role="alert" className="mt-5 text-sm text-destructive">{error}</p>}{message && <p role="status" className="mt-5 text-sm">{message}</p>}
  </div></main>;
}
