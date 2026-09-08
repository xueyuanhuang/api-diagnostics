'use client';
import { useState } from 'react';
import { Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function RawData({ title, text }: { title: string; text: string }) {
  const [message, setMessage] = useState('');
  return (
    <details className="group rounded-xl border border-border bg-background">
      <summary className="cursor-pointer px-4 py-3 text-xs font-semibold">
        {title}
      </summary>
      <div className="border-t border-border p-3">
        <div className="mb-2 flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(text);
                setMessage('Copied');
              } catch {
                setMessage(
                  'Copy unavailable. Select the text or download JSON.',
                );
              }
            }}
          >
            <Copy className="size-3" /> Copy
          </Button>
          <output className="text-xs text-muted-foreground">{message}</output>
        </div>
        <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted/60 p-3 font-mono text-[11px] leading-5">
          {text || '(empty)'}
        </pre>
      </div>
    </details>
  );
}
