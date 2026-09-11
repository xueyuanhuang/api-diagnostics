'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { TokenCheckApp } from '@/components/token-check-app';
import { PelicanTest } from '@/components/pelican-test';
import { ConnectionManager } from '@/components/connection-manager';
import { chatGPTSignInPath, chatGPTSignOutPath } from '@/lib/auth-paths';

export function SiteWorkspace({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const path = pathname?.replace(/\/$/, '') || '/';
  const [visited, setVisited] = useState<string[]>([path]);
  const [diagnosticsRunning, setDiagnosticsRunning] = useState(false);
  const [pelicanRunning, setPelicanRunning] = useState(false);
  useEffect(() => {
    setVisited(current => current.includes(path) ? current : [...current, path]);
    window.dispatchEvent(new Event('connections-refresh'));
  }, [path]);
  const knownPage = ['/', '/pelican', '/connections'].includes(path);
  return <>
    {knownPage && <nav aria-label="Website sections" className="sticky top-0 z-40 border-b border-border bg-card px-4 py-3 shadow-sm">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-3 text-sm">
        <Link href="/" aria-current={path === '/' ? 'page' : undefined} className="rounded-lg px-3 py-2 font-semibold hover:bg-muted aria-[current=page]:bg-primary aria-[current=page]:text-primary-foreground">All tests</Link>
        <Link href="/pelican" aria-current={path === '/pelican' ? 'page' : undefined} className="rounded-lg px-3 py-2 font-semibold hover:bg-muted aria-[current=page]:bg-primary aria-[current=page]:text-primary-foreground">Pelican animation</Link>
        <Link href="/connections" aria-current={path === '/connections' ? 'page' : undefined} className="rounded-lg px-3 py-2 font-semibold hover:bg-muted aria-[current=page]:bg-primary aria-[current=page]:text-primary-foreground">Connections</Link>
        <div role="status" className="flex flex-wrap gap-3 text-primary sm:ml-auto">
          {diagnosticsRunning && <Link href="/" className="font-semibold underline">Diagnostics running · View test</Link>}
          {pelicanRunning && <Link href="/pelican" className="font-semibold underline">Animation running · View test</Link>}
        </div>
      </div>
    </nav>}
    {/* Preserve each visited runner's component identity, request and result. */}
    <div hidden={path !== '/'}>{(visited.includes('/') || path === '/') && <TokenCheckApp signInPath={chatGPTSignInPath('/')} signOutPath={chatGPTSignOutPath('/')} onRunningChange={setDiagnosticsRunning} />}</div>
    <div hidden={path !== '/pelican'}>{(visited.includes('/pelican') || path === '/pelican') && <PelicanTest onRunningChange={setPelicanRunning} />}</div>
    <div hidden={path !== '/connections'}>{(visited.includes('/connections') || path === '/connections') && <ConnectionManager />}</div>
    {!knownPage && children}
  </>;
}
