'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { animationPreviewDocument } from '@/lib/pelican-test';

export function AnimationPreview({ html }: { html: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1000);
  const [height, setHeight] = useState(720);
  const [viewportHeight, setViewportHeight] = useState(900);
  const [expanded, setExpanded] = useState(false);
  const document = useMemo(() => animationPreviewDocument(html, true), [html]);
  useEffect(() => {
    const update = () => setViewportHeight(window.innerHeight);
    update();
    window.addEventListener('resize', update);
    let lastWidth = 0;
    const observer = new ResizeObserver(entries => {
      const next = Math.round(entries[0].contentRect.width);
      if (next > 0 && next !== lastWidth) { lastWidth = next; setWidth(next); setHeight(720); }
    });
    if (container.current) observer.observe(container.current);
    const message = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.data?.type !== 'pelican-preview-size') return;
      const value = event.data.height;
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) setHeight(Math.min(24000, Math.max(240, Math.ceil(value))));
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setExpanded(false); };
    window.addEventListener('message', message);
    window.addEventListener('keydown', escape);
    return () => { observer.disconnect(); window.removeEventListener('resize', update); window.removeEventListener('message', message); window.removeEventListener('keydown', escape); };
  }, []);
  const availableHeight = Math.max(240, expanded ? viewportHeight - 120 : Math.min(760, viewportHeight * 0.72));
  const scale = Math.min(1, availableHeight / height);
  return <div className={expanded ? 'fixed inset-3 z-50 overflow-auto rounded-xl border border-border bg-card shadow-2xl' : ''}>
    <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2">
      <span className="text-xs text-muted-foreground">Fits the whole animation to your window</span>
      <Button variant="outline" size="sm" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? 'Close expanded view' : 'Expand preview'}</Button>
    </div>
    <div ref={container} className="relative w-full overflow-hidden bg-muted/30" style={{ height: Math.ceil(height * scale) }}>
      <iframe ref={frame} title="Generated pelican animation" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={document} className="absolute top-0 border-0 bg-white" style={{ width, height, left: '50%', transform: `translateX(-50%) scale(${scale})`, transformOrigin: 'top center' }} />
    </div>
  </div>;
}
