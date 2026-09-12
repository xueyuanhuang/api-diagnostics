'use client';
import { useEffect, useRef, useState } from 'react';
import type { GalleryExample } from '@/lib/gallery';
import type { AnimationSummary } from '@/lib/animation-results';
type ManageData = {canManage: boolean; results: AnimationSummary[]; examples: GalleryExample[]; error?: string};
export function GalleryManager({examples, onPublished}: {examples: GalleryExample[]; onPublished: (items: GalleryExample[]) => void}) {
  const [canManage, setCanManage] = useState(false);
  const [results, setResults] = useState<AnimationSummary[]>([]);
  const [animationId, setAnimationId] = useState('');
  const [replaceId, setReplaceId] = useState('');
  const [description, setDescription] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  const savedAnimationSelect = useRef<HTMLSelectElement>(null);
  useEffect(() => { fetch('/api/gallery/manage').then(r => r.json() as Promise<ManageData>).then(data => {setCanManage(Boolean(data.canManage)); setResults(data.results ?? []); setMore(data.results?.length === 100);}).catch(() => {}); }, []);
  async function loadMore() {
    const last = results[results.length - 1];
    setBusy(true);
    try {
      const response = await fetch(`/api/gallery/manage?before=${encodeURIComponent(`${Date.parse(last.savedAt)}:${last.id}`)}`);
      const data = await response.json() as ManageData;
      if (!response.ok || !data.canManage) throw new Error(data.error || 'Sign in again to load your results.');
      setResults(previous => [...previous, ...data.results]); setMore(data.results.length === 100);
    } catch(error) { setMessage(error instanceof Error ? error.message : 'Could not load results.'); }
    finally { setBusy(false); }
  }
  async function publish() {
    setBusy(true); setMessage('Publishing…');
    try {
      const response = await fetch('/api/gallery/manage', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({animationId, replaceId, description})});
      const data = await response.json() as ManageData;
      if (!response.ok) throw new Error(data.error || 'Could not publish.');
      onPublished(data.examples); setMessage(replaceId ? 'Gallery example replaced. Your original saved result is unchanged.' : 'New model example published to the homepage.');
    } catch(error) { setMessage(error instanceof Error ? error.message : 'Could not publish.'); }
    finally { setBusy(false); }
  }
  async function removeExample(example: GalleryExample) {
    setBusy(true); setMessage(`Removing ${example.name} from the gallery…`);
    try {
      const response = await fetch('/api/gallery/manage', {method:'DELETE', headers:{'Content-Type':'application/json'}, body:JSON.stringify({id:example.id})});
      const data = await response.json() as ManageData;
      if (!response.ok) throw new Error(data.error || 'Could not delete this example.');
      onPublished(data.examples);
      if (replaceId === example.id) setReplaceId('');
      setMessage(`${example.name} deleted from the public gallery. Your saved test result is kept.`);
    } catch(error) { setMessage(error instanceof Error ? error.message : 'Could not delete this example.'); }
    finally { setBusy(false); }
  }
  function chooseReplacement(example: GalleryExample) {
    setReplaceId(example.id); setAnimationId(''); setDescription(example.description);
    setMessage(`Choose a saved animation below to replace ${example.name}.`);
    savedAnimationSelect.current?.focus();
    savedAnimationSelect.current?.scrollIntoView({behavior:'smooth', block:'center'});
  }
  if (!canManage) return null;
  const field = 'mt-2 w-full rounded-lg border border-border bg-background p-3 text-sm';
  return <details className="mb-6 rounded-2xl border border-border bg-card p-5">
    <summary className="cursor-pointer font-semibold">Manage public gallery · Your account</summary>
    <p className="mt-3 text-sm text-muted-foreground">Publish one of your saved tests for everyone to view. This shares its animation, model name and performance numbers. Your saved connection and key details stay private.</p>
    <section className="mt-5 border-b border-border pb-5" aria-label="Published gallery examples">
      <h2 className="font-semibold">Published examples</h2>
      <p className="mt-1 text-sm text-muted-foreground">Replace an animation or delete it from the homepage. Your saved test results are kept.</p>
      <ul className="mt-3 space-y-3">
        {examples.map(example => <li key={example.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
          <div className="min-w-0"><p className="font-medium">{example.name}</p><p className="text-sm text-muted-foreground">{example.description}</p></div>
          <div className="flex flex-wrap gap-2">
            <button className="rounded-lg border border-border px-3 py-2 text-sm font-medium disabled:opacity-50" disabled={busy} onClick={() => chooseReplacement(example)} aria-label={`Replace ${example.name}`}>Replace</button>
            <button className="rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50" disabled={busy} onClick={() => removeExample(example)} aria-label={`Delete ${example.name} from gallery`}>Delete from gallery</button>
          </div>
        </li>)}
      </ul>
      {examples.length === 0 && <p className="mt-3 text-sm text-muted-foreground">No published examples. Choose a saved animation below to add one.</p>}
    </section>
    <h2 className="mt-5 font-semibold">{replaceId ? 'Replace a published example' : 'Add a model example'}</h2>
    <div className="mt-4 grid gap-4 md:grid-cols-2">
      <label className="text-sm font-medium">Saved animation<select ref={savedAnimationSelect} className={field} value={animationId} onChange={e => setAnimationId(e.target.value)} disabled={busy}><option value="">Choose a saved result</option>{results.map(item => <option key={item.id} value={item.id}>{item.model} · {new Date(item.savedAt).toLocaleString()} · {item.connectionName || 'Unlabelled connection'}</option>)}</select></label>
      <label className="text-sm font-medium">Where to publish<select className={field} value={replaceId} onChange={e => setReplaceId(e.target.value)} disabled={busy}><option value="">Add a new model example</option>{examples.map(item => <option key={item.id} value={item.id}>Replace {item.name} — {item.description}</option>)}</select></label>
      <label className="text-sm font-medium md:col-span-2">Short description (optional)<input className={field} maxLength={200} value={description} onChange={e => setDescription(e.target.value)} placeholder="What is distinctive about this animation?" disabled={busy}/></label>
    </div>
    {more && <button className="mt-3 text-sm underline" disabled={busy} onClick={loadMore}>Load older saved results</button>}
    <button className="mt-4 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50" disabled={busy || !animationId} onClick={publish}>{busy ? 'Working…' : replaceId ? 'Replace public example' : 'Publish to homepage'}</button>
    <p className="mt-3 text-sm" role="status">{message}</p>
  </details>;
}
