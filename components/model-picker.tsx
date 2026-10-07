'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function ModelPicker({ models, value, onChange, disabled = false, connectionName, onAddModels }: {
  models: string[];
  value: string;
  onChange: (model: string) => void;
  disabled?: boolean;
  connectionName?: string;
  onAddModels?: (models: string[]) => Promise<{ added: number }>;
}) {
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [pendingModels, setPendingModels] = useState<string[] | null>(null);
  const savingRef = useRef(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [copyResult, setCopyResult] = useState<{ model: string; success: boolean } | null>(null);
  const copied = copyResult?.model === value && copyResult.success;
  const copyFailed = copyResult?.model === value && !copyResult.success;
  useEffect(() => {
    if (!copyResult?.success) return;
    const timer = setTimeout(() => setCopyResult(null), 2000);
    return () => clearTimeout(timer);
  }, [copyResult]);
  async function copyModel() {
    try {
      await navigator.clipboard.writeText(value);
      setCopyResult({ model: value, success: true });
    } catch {
      setCopyResult({ model: value, success: false });
    }
  }
  const sorted = [...new Set(models)].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true }));
  const matches = sorted.filter(model => model.toLowerCase().includes(query.trim().toLowerCase()));
  const keepCurrent = value && !matches.includes(value);
  const candidates = [...new Set(query.trim().split(/[\s,]+/).filter(Boolean))];
  const newCandidates = candidates.filter(model => !sorted.includes(model));
  function changeQuery(next: string) {
    setQuery(next); setPendingModels(null); setMessage(''); setError('');
  }
  function requestSelection(text: string) {
    if (disabled || savingRef.current) return;
    const requested = [...new Set(text.trim().split(/[\s,]+/).filter(Boolean))];
    if (!requested.length) return;
    if (requested.some(model => model.length > 120)) {
      setError('Model IDs must be 120 characters or fewer.'); return;
    }
    const missing = requested.filter(model => !sorted.includes(model));
    const selected = missing[0] ?? requested[0];
    if (!missing.length) {
      onChange(selected); setQuery(''); setPendingModels(null); setError('');
      setMessage('Selected saved model.'); return;
    }
    if (!onAddModels) return;
    if (sorted.length + missing.length > 200) {
      setError('This connection supports 200 saved models. Remove unused models in Connections first.'); return;
    }
    setError(''); setPendingModels(missing);
  }
  async function confirmAddition() {
    if (!onAddModels || !pendingModels?.length || disabled || savingRef.current) return;
    const requested = pendingModels;
    savingRef.current = true; setSaving(true); setError(''); setMessage('');
    try {
      const saved = await onAddModels(requested);
      onChange(requested[0]); setQuery(''); setPendingModels(null);
      setMessage(saved.added
        ? `Added ${saved.added === 1 ? 'model' : `${saved.added} models`} to ${connectionName || 'this connection'}. Ready to use in all tests.`
        : 'Model already saved. Ready to use.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save models. Try again.');
    } finally { savingRef.current = false; setSaving(false); }
  }
  return <div className="mt-2 space-y-2">
    <Input type="search" aria-label="Search models" placeholder={onAddModels ? `Search ${sorted.length} models or paste an ID…` : `Search ${sorted.length} models…`} value={query} disabled={disabled || saving}
      onChange={event => changeQuery(event.target.value)}
      onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); if (!event.nativeEvent.isComposing) requestSelection(query); }
        if (event.key === 'Escape') changeQuery('');
      }}
      onPaste={event => {
        if (!onAddModels || disabled || savingRef.current) return;
        // Pasting into part of an existing search edits that search; it must not
        // silently save only the pasted fragment as a new model.
        const input = event.currentTarget;
        if (query && (input.selectionStart !== 0 || input.selectionEnd !== query.length)) return;
        const text = event.clipboardData.getData('text').trim();
        if (!text) return;
        event.preventDefault(); changeQuery(text.replace(/\s+/g, ' '));
        const pasted = text.split(/[\s,]+/).filter(Boolean);
        // A pasted search term such as "claude" still filters matching IDs.
        // Exact IDs select immediately; unmatched IDs require confirmation.
        if (pasted.length > 1 || sorted.includes(text) || !sorted.some(model => model.toLowerCase().includes(text.toLowerCase()))) requestSelection(text);
      }} />
    {onAddModels && <p className="text-xs font-normal text-muted-foreground">Paste a new model ID, or type it and press Enter. You’ll confirm before it’s saved.</p>}
    <div className="flex min-w-0 items-center gap-2">
      <select aria-label="Model name" title={value || undefined} value={value} disabled={disabled || saving} onChange={event => { onChange(event.target.value); changeQuery(''); }} className="h-10 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-sm">
        {!value && <option value="" disabled>Choose a model</option>}
        {keepCurrent && <optgroup label="Current model"><option value={value}>{value}</option></optgroup>}
        {matches.map(model => <option key={model} value={model}>{model}</option>)}
      </select>
      <Button type="button" variant="outline" className="h-10 shrink-0" disabled={!value} aria-label="Copy model name" title="Copy the full model name" onClick={copyModel}>
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        <span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
      </Button>
    </div>
    {copyFailed && <output className="block text-xs font-normal text-muted-foreground">Could not copy automatically. Select and copy the model name: <span className="select-text break-all">{value}</span></output>}
    {query && !saving && <output className="block text-xs font-normal text-muted-foreground">{matches.length ? `${matches.length} matching model${matches.length === 1 ? '' : 's'}` : onAddModels ? 'No matching saved models.' : 'No matching models. Try another search.'}</output>}
    {onAddModels && newCandidates.length > 0 && !pendingModels && <Button type="button" variant="outline" disabled={disabled || saving} onClick={() => requestSelection(query)}><Plus aria-hidden="true" />{newCandidates.length === 1 ? 'Add & use model' : `Add ${newCandidates.length} models`}</Button>}
    {onAddModels && pendingModels && <section aria-label="Confirm adding models" className="space-y-3 rounded-lg border border-border bg-muted/50 p-3 text-sm">
      <p className="font-semibold">{pendingModels.length === 1 ? 'Add this model' : `Add these ${pendingModels.length} models`} to {connectionName || 'this connection'}?</p>
      <ul className="max-h-36 space-y-1 overflow-y-auto text-xs font-normal">{pendingModels.map(model => <li key={model} className="break-all font-mono">{model}</li>)}</ul>
      <p className="text-xs font-normal text-muted-foreground">{pendingModels.length === 1 ? 'It will be saved and selected' : 'They will be saved, and the first new model selected'} for testing.</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={disabled || saving} onClick={() => void confirmAddition()}>{saving ? 'Saving…' : 'Confirm & add'}</Button>
        <Button type="button" variant="outline" disabled={disabled || saving} onClick={() => changeQuery('')}>Cancel</Button>
      </div>
    </section>}
    {error && <p role="alert" className="break-words text-xs font-normal text-destructive">{error}</p>}
    {message && <output className="block text-xs font-normal text-muted-foreground">{message}</output>}
  </div>;
}
