export const MCP_SCOPE = 'results:read';
export function allowedRedirect(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.origin === 'https://chatgpt.com' && !url.username && !url.password && !url.search && !url.hash && (url.pathname === '/connector_platform_oauth_redirect' || /^\/connector\/oauth\/[a-zA-Z0-9_-]+$/.test(url.pathname));
  } catch { return false; }
}
export function scrubEvidence(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/\bsk-[a-zA-Z0-9_-]{8,}\b/g, '[REDACTED]').replace(/Bearer\s+[a-zA-Z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]');
  if (Array.isArray(value)) return value.map(scrubEvidence);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(api_?key|encrypted_?api_?key|key_?iv|key_?hint|authorization|cookie|set-cookie|user_?id|evidence_?key)$/i.test(key)).map(([key, val]) => [key, scrubEvidence(val)]));
  return value;
}

export async function readBoundedBody(request: Request, limit: number) {
  const reader = request.body?.getReader(); if (!reader) return '';
  let size = 0, text = ''; const decoder = new TextDecoder();
  while (true) { const {done,value} = await reader.read(); if (done) break; size += value.byteLength; if (size > limit) { await reader.cancel(); return null; } text += decoder.decode(value,{stream:true}); }
  return text + decoder.decode();
}
