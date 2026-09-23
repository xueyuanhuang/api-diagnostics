'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { connectionRequest, type SavedConnection } from '@/lib/saved-connections';

export function ConnectionModels({ profile, disabled, onBusyChange, onSaved }: {
  profile: SavedConnection;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onSaved: (models: string[]) => void;
}) {
  const type = profile.defaultApiType;
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
      onSaved(saved.models); setDraft('');
      setMessage(saved.added ? `Added ${saved.added} model${saved.added === 1 ? '' : 's'}. Available in all tests.` : 'These models are already saved.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not add models.'); }
    finally { setSaving(false); onBusyChange(false); }
  }
  return <details className="border-t border-border pt-3">
    <summary className="cursor-pointer text-sm font-semibold text-primary">Add models</summary>
    <form onSubmit={add} className="mt-4 space-y-3">
      <fieldset disabled={disabled || saving} className="space-y-3">
        <p className="text-sm text-muted-foreground">Models for {profile.name} are shared across both API formats and all tests.</p>
        <div className="flex flex-wrap gap-2" aria-label="Saved models">{[...config.models].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map(model => <span key={model} className="max-w-full break-all rounded-md bg-muted px-2 py-1 text-sm">{model}</span>)}</div>
        <label className="block text-sm font-medium">New models<textarea value={draft} onChange={event => setDraft(event.target.value)} placeholder="One model per line, or separated by commas" className="mt-2 min-h-24 w-full rounded-lg border border-input bg-background p-3 text-sm" /></label>
        <p className="text-sm text-muted-foreground">Up to 200 models per connection. Each format keeps its saved URL and key.</p>
        <Button type="submit" disabled={!draft.trim() || disabled || saving}>{saving ? 'Adding models…' : 'Add models to connection'}</Button>
      </fieldset>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {message && <p role="status" className="text-sm">{message}</p>}
    </form>
  </details>;
}
