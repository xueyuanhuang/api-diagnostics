'use client';

import { createContext, useCallback, useContext, useEffect, useState, type AnchorHTMLAttributes, type ReactNode } from 'react';

const workspacePages = new Set(['/', '/pelican', '/connections']);
const normalizePath = (path: string) => path.replace(/\/$/, '') || '/';
const NavigationContext = createContext<{ path: string; navigate: (href: string) => boolean } | null>(null);

// These sections already live in one persistent workspace. Change the visible
// section without fetching another server tree or unmounting an active test.
export function WorkspaceNavigation({ initialPath, children }: { initialPath: string; children: ReactNode }) {
  const [path, setPath] = useState(() => normalizePath(initialPath));
  const navigate = useCallback((href: string) => {
    const destination = new URL(href, window.location.href);
    const nextPath = normalizePath(destination.pathname);
    if (!workspacePages.has(path) || destination.origin !== window.location.origin || !workspacePages.has(nextPath)) return false;
    if (destination.href !== window.location.href) window.history.pushState(window.history.state, '', destination);
    setPath(nextPath);
    window.scrollTo(0, 0);
    return true;
  }, [path]);

  useEffect(() => {
    const onBackOrForward = (event: PopStateEvent) => {
      const nextPath = normalizePath(window.location.pathname);
      if (!workspacePages.has(path) || !workspacePages.has(nextPath)) return;
      // The workspace owns these history entries; the server router must not
      // replace its mounted runners when the browser moves back or forward.
      event.stopImmediatePropagation();
      setPath(nextPath);
    };
    window.addEventListener('popstate', onBackOrForward, true);
    return () => window.removeEventListener('popstate', onBackOrForward, true);
  }, [path]);

  return <NavigationContext.Provider value={{ path, navigate }}>{children}</NavigationContext.Provider>;
}

export function useWorkspaceNavigation() {
  const context = useContext(NavigationContext);
  return context ?? { path: '/', navigate: (_href: string) => false };
}

export function WorkspaceLink({ href, onClick, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const { navigate } = useWorkspaceNavigation();
  return <a {...props} href={href} onClick={event => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.currentTarget.hasAttribute('download') || (event.currentTarget.target && event.currentTarget.target !== '_self')) return;
    if (navigate(href)) event.preventDefault();
  }} />;
}
