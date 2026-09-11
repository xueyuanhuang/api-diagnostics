'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { connectionRequest, type ConnectionApiType, type SavedConnection } from '@/lib/saved-connections';

export function ConnectionModels({ profile, disabled, onBusyChange, onSaved }: {
  profile: SavedConnection;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onSaved: (type: ConnectionApiType, models: string[]) => void;
}) {
  const [type, setType] = useState<ConnectionApiType>(profile.defaultApiType);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const config = profile.configs[type];
  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (saving || disabled) return;
    const models = [...new Set(draft.split(/[\n,]/).map(value => value.trim()).filter(Boolean))];
    if (!models.length) return;
    if (models.some(model => model.length > 120)) { setError('Model names must be 120 characters or fewer.'); return; }
    setSaving(true); onBusyChange(true); setError(''); setMessage('');
    try {
      const saved = await connectionRequest<{ models: string[]; added: number }>(`/api/profiles/${encodeURIComponent(profile.id)}/models`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiType: type, baseUrl: config.baseUrl, models }),
      });
      onSaved(type, saved.models); setDraft('');
      setMessage(saved.added ? `Added ${saved.added} model${saved.added === 1 ? '' : 's'}. Available in all tests.` : 'These models are already saved.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not add models.'); }
    finally { setSaving(false); onBusyChange(false); }
  }
  return <details className="border-t border-border pt-3">
    <summary className="cursor-pointer text-sm font-semibold text-primary">Add models</summary>
    <form onSubmit={add} className="mt-4 space-y-3">
      <fieldset disabled={disabled || saving} className="space-y-3">
        <label className="block text-sm font-medium">API format for {profile.name}<select value={type} onChange={event => { setType(event.target.value as ConnectionApiType); setMessage(''); setError(''); }} className="mt-2 h-10 w-full rounded-lg border border-input bg-background px-3"><option value="openai">OpenAI-compatible</option><option value="anthropic">Anthropic-compatible</option></select></label>
        <div className="flex flex-wrap gap-2" aria-label="Saved models">{config.models.map(model => <span key={model} className="max-w-full break-all rounded-md bg-muted px-2 py-1 text-sm">{model}{model === config.model ? ' (default)' : ''}</span>)}</div>
        <label className="block text-sm font-medium">New models<textarea value={draft} onChange={event => setDraft(event.target.value)} placeholder="One model per line, or separated by commas" className="mt-2 min-h-24 w-full rounded-lg border border-input bg-background p-3 text-sm" /></label>
        <p className="text-sm text-muted-foreground">Up to 200 models per API format. Uses the existing saved URL and key.</p>
        <Button type="submit" disabled={!draft.trim() || disabled || saving}>{saving ? 'Adding models…' : 'Add models to connection'}</Button>
      </fieldset>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {message && <p role="status" className="text-sm">{message}</p>}
    </form>
  </details>;
}
