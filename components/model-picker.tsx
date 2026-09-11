'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/input';

export function ModelPicker({ models, value, onChange, disabled = false }: {
  models: string[];
  value: string;
  onChange: (model: string) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState('');
  const sorted = [...new Set(models)].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true }));
  const matches = sorted.filter(model => model.toLowerCase().includes(query.trim().toLowerCase()));
  const keepCurrent = value && !matches.includes(value);
  return <div className="mt-2 space-y-2">
    <Input type="search" aria-label="Search models" placeholder={`Search ${sorted.length} models…`} value={query} disabled={disabled} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') event.preventDefault(); }} />
    <select aria-label="Model name" value={value} disabled={disabled} onChange={event => { onChange(event.target.value); setQuery(''); }} className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm">
      {!value && <option value="" disabled>Choose a model</option>}
      {keepCurrent && <optgroup label="Current model"><option value={value}>{value}</option></optgroup>}
      {matches.map(model => <option key={model} value={model}>{model}</option>)}
    </select>
    {query && <p role="status" className="text-xs font-normal text-muted-foreground">{matches.length ? `${matches.length} matching model${matches.length === 1 ? '' : 's'}` : 'No matching models. Try another search.'}</p>}
  </div>;
}
