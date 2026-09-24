import { readApiResponse } from './api-response';
export type ConnectionApiType = 'openai' | 'anthropic';
export type SavedConnection = {
  id: string;
  name: string;
  defaultApiType: ConnectionApiType;
  configs: Record<ConnectionApiType, { baseUrl: string; model: string; models: string[]; hasSavedKey: boolean }>;
};

const ACTIVE_CONNECTION_KEY = 'api-diagnostics:active-connection:v1';
const CONNECTION_SELECTION_KEY = 'api-diagnostics:connection-selection:v1:';
type ConnectionSelection = { apiType: ConnectionApiType; model: string };

// This device preference is separate from the connection's saved defaults.
// Read it when applying a profile, rather than writing initial React state back.
export function connectionSelection(profile: SavedConnection): ConnectionSelection {
  let saved: Partial<ConnectionSelection> | null = null;
  try {
    saved = JSON.parse(localStorage.getItem(CONNECTION_SELECTION_KEY + profile.id) || 'null');
  } catch { /* Unavailable or corrupt preferences fall back to this profile. */ }
  const apiType = saved?.apiType === 'openai' || saved?.apiType === 'anthropic'
    ? saved.apiType
    : profile.defaultApiType;
  const config = profile.configs[apiType];
  const model = typeof saved?.model === 'string' && (saved.model === config.model || config.models.includes(saved.model))
    ? saved.model
    : config.model || config.models[0] || '';
  return { apiType, model };
}

export function rememberConnectionSelection(id: string, selection: ConnectionSelection) {
  if (!id || !selection.model.trim()) return;
  try {
    localStorage.setItem(CONNECTION_SELECTION_KEY + id, JSON.stringify({
      apiType: selection.apiType,
      model: selection.model.trim(),
    }));
  } catch { /* A blocked preference store does not prevent testing. */ }
}

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
  return readApiResponse<T>(response);
}
