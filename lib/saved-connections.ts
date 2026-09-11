export type ConnectionApiType = 'openai' | 'anthropic';
export type SavedConnection = {
  id: string;
  name: string;
  defaultApiType: ConnectionApiType;
  configs: Record<ConnectionApiType, { baseUrl: string; model: string; models: string[]; hasSavedKey: boolean }>;
};

const ACTIVE_CONNECTION_KEY = 'api-diagnostics:active-connection:v1';
export function activeConnectionId() {
  try { return localStorage.getItem(ACTIVE_CONNECTION_KEY) || ''; } catch { return ''; }
}
export function rememberConnection(id: string) {
  try {
    if (id) localStorage.setItem(ACTIVE_CONNECTION_KEY, id);
    else localStorage.removeItem(ACTIVE_CONNECTION_KEY);
  } catch { /* A blocked preference store does not prevent testing. */ }
}

export async function connectionRequest<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...options, cache: 'no-store' });
  const data = await response.json() as { error?: string };
  if (!response.ok) throw new Error(data.error || 'Could not load connections.');
  return data as T;
}
