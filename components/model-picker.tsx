'use client';

import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function ModelPicker({ models, value, onChange, disabled = false }: {
  models: string[];
  value: string;
  onChange: (model: string) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState('');
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
  return <div className="mt-2 space-y-2">
    <Input type="search" aria-label="Search models" placeholder={`Search ${sorted.length} models…`} value={query} disabled={disabled} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') event.preventDefault(); }} />
    <div className="flex min-w-0 items-center gap-2">
      <select aria-label="Model name" title={value || undefined} value={value} disabled={disabled} onChange={event => { onChange(event.target.value); setQuery(''); }} className="h-10 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-sm">
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
    {query && <output className="block text-xs font-normal text-muted-foreground">{matches.length ? `${matches.length} matching model${matches.length === 1 ? '' : 's'}` : 'No matching models. Try another search.'}</output>}
  </div>;
}
