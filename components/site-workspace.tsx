'use client';

import { useEffect, useState } from 'react';
import { WorkspaceLink as Link } from '@/components/workspace-navigation';
import { usePathname } from 'next/navigation';
import { WorkspaceNavigation, useWorkspaceNavigation } from '@/components/workspace-navigation';
import { PelicanShowcase } from '@/components/pelican-showcase';
import { TokenCheckApp } from '@/components/token-check-app';
import { PelicanTest } from '@/components/pelican-test';
import { ConnectionManager } from '@/components/connection-manager';
import { chatGPTSignInPath, chatGPTSignOutPath } from '@/lib/auth-paths';

export function SiteWorkspace({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return <WorkspaceNavigation initialPath={pathname || '/'}><WorkspaceViews>{children}</WorkspaceViews></WorkspaceNavigation>;
}

function WorkspaceViews({ children }: { children: React.ReactNode }) {
  const { path } = useWorkspaceNavigation();
  const [visited, setVisited] = useState<string[]>([path]);
  const [diagnosticsRunning, setDiagnosticsRunning] = useState(false);
  const [pelicanRunning, setPelicanRunning] = useState(false);
  const [account, setAccount] = useState<{ displayName: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/session', { cache: 'no-store', signal: controller.signal })
      .then(response => response.ok ? response.json() as Promise<{ user: { displayName: string } | null }> : null)
      .then(session => { if (!controller.signal.aborted) setAccount(session?.user ?? null); })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  useEffect(() => {
    setVisited(current => current.includes(path) ? current : [...current, path]);
    window.dispatchEvent(new Event('connections-refresh'));
  }, [path]);
  const knownPage = ['/', '/tests', '/pelican', '/connections'].includes(path);
  return <>
    <nav aria-label="Website sections" className="sticky top-0 z-40 border-b border-border bg-card px-4 py-3 shadow-sm">
      <div className="mx-auto grid max-w-[1400px] grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-sm">
        <div className="col-span-2 row-start-2 flex items-center gap-1 overflow-x-auto whitespace-nowrap md:col-span-1 md:row-start-1 md:gap-3">
        <Link href="/" aria-current={path === '/' ? 'page' : undefined} className="rounded-lg px-3 py-2 font-semibold hover:bg-muted aria-[current=page]:bg-primary aria-[current=page]:text-primary-foreground">Model gallery</Link>
        <Link href="/tests" aria-current={path === '/tests' ? 'page' : undefined} className="rounded-lg px-3 py-2 font-semibold hover:bg-muted aria-[current=page]:bg-primary aria-[current=page]:text-primary-foreground">All tests</Link>
        <Link href="/pelican" aria-current={path === '/pelican' ? 'page' : undefined} className="rounded-lg px-3 py-2 font-semibold hover:bg-muted aria-[current=page]:bg-primary aria-[current=page]:text-primary-foreground">Pelican animation</Link>
        <Link href="/connections" aria-current={path === '/connections' ? 'page' : undefined} className="rounded-lg px-3 py-2 font-semibold hover:bg-muted aria-[current=page]:bg-primary aria-[current=page]:text-primary-foreground">Connections</Link>
        </div>
        <div aria-label="Account" className="col-start-2 row-start-1 flex items-center justify-end gap-3">
          {account ? <>
            <span className="max-w-32 truncate font-medium sm:max-w-48" title={account.displayName}>{account.displayName}</span>
            <a href={chatGPTSignOutPath(path)} target="_top" className="whitespace-nowrap rounded-lg border border-border px-4 py-2 font-semibold hover:bg-muted">Sign out</a>
          </> : <a href={chatGPTSignInPath(path)} target="_top" className="whitespace-nowrap rounded-lg bg-primary px-4 py-2 font-semibold text-primary-foreground shadow-sm hover:opacity-90">Sign in with Google</a>}
        </div>
        {(diagnosticsRunning || pelicanRunning) && <div role="status" className="col-span-2 flex flex-wrap justify-end gap-3 text-primary">
          {diagnosticsRunning && <Link href="/tests" className="font-semibold underline">Diagnostics running · View test</Link>}
          {pelicanRunning && <Link href="/pelican" className="font-semibold underline">Animation running · View test</Link>}
        </div>}
      </div>
    </nav>
    {/* Preserve each visited runner's component identity, request and result. */}
    {path === '/' && <PelicanShowcase />}
    <div hidden={path !== '/tests'}>{(visited.includes('/tests') || path === '/tests') && <TokenCheckApp signInPath={chatGPTSignInPath('/tests')} onRunningChange={setDiagnosticsRunning} />}</div>
    <div hidden={path !== '/pelican'}>{(visited.includes('/pelican') || path === '/pelican') && <PelicanTest onRunningChange={setPelicanRunning} />}</div>
    <div hidden={path !== '/connections'}>{(visited.includes('/connections') || path === '/connections') && <ConnectionManager />}</div>
    {!knownPage && children}
  </>;
}
