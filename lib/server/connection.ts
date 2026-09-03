export type ApiType = 'anthropic' | 'openai';

function parseIpv4(hostname: string) {
  const parts = hostname.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const numbers = parts.map(Number);
  return numbers.some((part) => part < 0 || part > 255) ? null : numbers;
}

function isNonPublicIpv4(parts: number[]) {
  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isBlockedHostname(rawHostname: string) {
  const hostname = rawHostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (
    hostname === 'localhost' ||
    hostname === 'localhost.localdomain' ||
    hostname === 'metadata.google.internal' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    return true;
  }
  const ipv4 = parseIpv4(hostname);
  if (ipv4) return isNonPublicIpv4(ipv4);
  return hostname.includes(':');
}

export function validateBaseUrl(rawBaseUrl: string): { baseUrl: string } | { error: string } {
  let url: URL;
  try {
    url = new URL(rawBaseUrl);
  } catch {
    return { error: 'Enter a valid base URL.' };
  }
  if (url.protocol !== 'https:') return { error: 'Only public HTTPS base URLs are supported.' };
  if (url.username || url.password || (url.port && url.port !== '443')) {
    return { error: 'URL credentials and custom ports are not supported.' };
  }
  if (isBlockedHostname(url.hostname)) {
    return { error: 'Local and private-network base URLs are blocked.' };
  }
  if (url.search) return { error: 'The base URL cannot contain query parameters.' };
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return { baseUrl: url.toString().replace(/\/$/, '') };
}

export function endpointFromBaseUrl(baseUrl: string, apiType: ApiType) {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, '');
  const completePath = apiType === 'anthropic' ? '/v1/messages' : '/v1/chat/completions';
  const finalSegment = apiType === 'anthropic' ? '/messages' : '/chat/completions';
  if (path.endsWith(completePath)) {
    url.pathname = path;
  } else if (path.endsWith('/v1')) {
    url.pathname = `${path}${finalSegment}`;
  } else {
    url.pathname = `${path}${completePath}`.replace(/^\/\//, '/');
  }
  return url;
}

export function normalizeModels(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))].slice(0, 20);
}
