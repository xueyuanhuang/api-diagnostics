'use client';

import { useEffect, useState } from 'react';
import { AnimationPreview } from '@/components/animation-preview';
import { WorkspaceLink } from '@/components/workspace-navigation';
import { PELICAN_PROMPT } from '@/lib/pelican-test';

const examples = [
  { id: 'gpt-6-astra', name: 'gpt-6-astra', description: 'A coastal ride, with a helmet and scarf.', seconds: '178.6', tokens: '6,478' },
  { id: 'gpt-5.6-sol', name: 'gpt-5.6-sol', description: 'A bright sky and a bold red bicycle.', seconds: '55.6', tokens: '5,406' },
  { id: 'claude-opus-5', name: 'claude-opus-5', description: 'Another take on the same cycling challenge.', seconds: '142.2', tokens: '12,013' },
];

function Example({ id }: { id: string }) {
  const example = examples.find(item => item.id === id)!;
  const [html, setHtml] = useState('');
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setHtml(''); setError(false);
    fetch(`/showcase/${id}.txt`, { signal: controller.signal }).then(response => {
      if (!response.ok) throw new Error('Unavailable');
      return response.text();
    }).then(setHtml).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [id, attempt]);
  return <section className="min-w-0 overflow-hidden rounded-2xl border border-border bg-card shadow-sm" aria-label={`${example.name} animation`}>
    <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-4">
      <h2 className="font-semibold">{example.name}</h2>
      <span className="text-xs text-muted-foreground">Saved example · {example.seconds}s · {example.tokens} output tokens</span>
    </div>
    {html ? <AnimationPreview key={`${id}-${attempt}`} html={html} /> : <div className="flex min-h-80 items-center justify-center p-8 text-muted-foreground" role="status">{error ? <button className="underline" onClick={() => setAttempt(value => value + 1)}>Could not load this animation. Try again</button> : 'Loading animation…'}</div>}
  </section>;
}

export function PelicanShowcase() {
  const [selected, setSelected] = useState(examples[0].id);
  const [compare, setCompare] = useState(false);
  const [second, setSecond] = useState(examples[1].id);
  function select(id: string) {
    setSelected(id);
    if (second === id) setSecond(examples.find(item => item.id !== id)!.id);
  }
  return <main className="mx-auto max-w-[1400px] px-4 py-8 sm:px-6 sm:py-12">
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify({ '@context': 'https://schema.org', '@type': 'WebApplication', name: 'Pelican Test', url: 'https://api-diagnostics.xue-yuanhuang.workers.dev/', applicationCategory: 'DeveloperApplication', operatingSystem: 'Any', browserRequirements: 'Requires JavaScript', description: 'Compare saved AI-generated SVG animations of a pelican riding a bicycle, or test your own model.' }) }} />
    <header className="mb-8 flex flex-wrap items-end justify-between gap-6">
      <div className="max-w-2xl">
        <p className="mb-3 text-xs font-semibold uppercase tracking-[0.22em] text-primary">The pelican test · Model gallery</p>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-5xl">One pelican. One bicycle.<br />Different models.</h1>
        <p className="mt-4 text-base leading-relaxed text-muted-foreground">Give each model the same drawing challenge. See how it turns a sentence into a moving scene.</p>
        <p className="mt-3 text-sm font-medium text-primary">Browse freely — no sign-in or API key needed.</p>
      </div>
      <WorkspaceLink href="/pelican" className="rounded-xl bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground">Test your own model →</WorkspaceLink>
    </header>
    <div className="mb-6 grid gap-3 sm:grid-cols-3" aria-label="Choose a model">
      {examples.map(example => <button key={example.id} aria-pressed={selected === example.id} onClick={() => select(example.id)} className={`rounded-xl border p-4 text-left transition-colors ${selected === example.id ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card hover:bg-muted'}`}>
        <span className="block font-semibold">{example.name}</span>
        <span className={`mt-1 block text-sm ${selected === example.id ? 'text-primary-foreground/80' : 'text-muted-foreground'}`}>{example.description}</span>
      </button>)}
    </div>
    <div className="mb-4 flex flex-wrap items-center gap-4">
      <label className="flex cursor-pointer items-center gap-2 text-sm font-medium"><input type="checkbox" checked={compare} onChange={event => setCompare(event.target.checked)} className="size-4 accent-primary" />Compare side by side</label>
      {compare && <label className="flex items-center gap-2 text-sm">Compare with <select className="rounded-lg border border-border bg-card px-3 py-2" value={second} onChange={event => setSecond(event.target.value)}>{examples.filter(item => item.id !== selected).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
    </div>
    <div className={`grid items-start gap-5 ${compare ? 'lg:grid-cols-2' : ''}`}>
      <Example key={selected} id={selected} />
      {compare && <Example key={`compare-${second}`} id={second} />}
    </div>
    <div className="mt-6 grid gap-5 md:grid-cols-2">
      <details className="rounded-xl border border-border bg-card p-5"><summary className="cursor-pointer font-semibold">The same prompt for every example</summary><p className="mt-4 text-sm leading-relaxed">{PELICAN_PROMPT}</p><p className="mt-3 text-sm text-muted-foreground">Create an HTML page containing a 2D SVG animation of a pelican riding a bicycle. No tests are needed.</p></details>
      <div className="rounded-xl border border-border bg-card p-5"><h2 className="font-semibold">Look beyond a pretty picture</h2><p className="mt-2 text-sm leading-relaxed text-muted-foreground">Do the pedals, wheels and rider move together? Does the scene follow the prompt? These are individual saved outputs, not an intelligence ranking. Model names are those recorded by the API; settings and response times can differ.</p></div>
    </div>
    <section className="mt-10 rounded-2xl border border-border bg-card p-6 sm:p-8" aria-labelledby="about-pelican">
      <h2 id="about-pelican" className="text-2xl font-semibold">What is the Pelican Test?</h2>
      <p className="mt-3 max-w-3xl leading-relaxed text-muted-foreground">Pelican Test is a visual coding experiment inside API Diagnostics. It asks language models to create an HTML page with a 2D SVG animation of a pelican riding a bicycle. This independent project makes their outputs easy to watch, compare and revisit.</p>
      <h3 className="mt-7 text-lg font-semibold">How to use this website</h3>
      <ol className="mt-4 grid gap-6 md:grid-cols-3">
        <li><strong>1. Watch the examples</strong><p className="mt-2 text-sm leading-relaxed text-muted-foreground">Choose a model above to play its saved animation. Turn on side-by-side comparison to look at two results. Viewing is open to everyone.</p></li>
        <li><strong>2. Try your own model</strong><p className="mt-2 text-sm leading-relaxed text-muted-foreground">Open the animation test, enter your provider’s Base URL, API key and exact model name, and choose the matching API format. Set an output limit and start the test. Your provider may charge for the request.</p></li>
        <li><strong>3. Keep your results</strong><p className="mt-2 text-sm leading-relaxed text-muted-foreground">Download the generated HTML. Sign in if you want to save connections and successful test results to your account and access them across devices.</p></li>
      </ol>
      <div className="mt-7 flex flex-wrap gap-4 text-sm font-semibold text-primary"><WorkspaceLink href="/pelican" className="underline">Run the pelican test →</WorkspaceLink><WorkspaceLink href="/connections" className="underline">Manage your connections →</WorkspaceLink></div>
    </section>
    <section className="mt-8" aria-label="Frequently asked questions">
      <h2 className="mb-4 text-2xl font-semibold">A few things to know</h2>
      <div className="grid gap-4 md:grid-cols-2">
        <details className="rounded-xl border border-border bg-card p-5"><summary className="cursor-pointer font-semibold">Do I need to sign in to see the animations?</summary><p className="mt-3 text-sm text-muted-foreground">No. The public gallery works without an account or API key. You can also run a one-time test with your own connection without signing in.</p></details>
        <details className="rounded-xl border border-border bg-card p-5"><summary className="cursor-pointer font-semibold">Does this measure a model’s intelligence?</summary><p className="mt-3 text-sm text-muted-foreground">It gives a useful glimpse of instruction following, visual structure and code generation. One creative task is not a comprehensive benchmark. Compare multiple runs under similar settings before drawing conclusions.</p></details>
      </div>
    </section>
    <p className="mt-5 text-xs text-muted-foreground">Examples are shared for viewing. Running a new test uses your own provider connection. <WorkspaceLink href="/tests" className="underline">Explore all API tests →</WorkspaceLink></p>
  </main>;
}
