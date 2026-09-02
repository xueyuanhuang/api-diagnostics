import { NextRequest, NextResponse } from 'next/server';

type ApiFormat = 'anthropic' | 'openai';

type RequestPayload = {
  apiFormat?: unknown;
  endpoint?: unknown;
  apiKey?: unknown;
  model?: unknown;
  prompt?: unknown;
};

const MAX_RESPONSE_BYTES = 1_000_000;

function noStore<T>(body: T, init?: ResponseInit) {
  const response = NextResponse.json(body, init);
  response.headers.set('Cache-Control', 'no-store, max-age=0');
  response.headers.set('Pragma', 'no-cache');
  return response;
}

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

  // Provider domains may resolve to IPv6 normally, but literal IPv6 URLs are
  // unnecessary here and are harder to classify safely for a public relay.
  if (hostname.includes(':')) return true;

  return false;
}

function validateEndpoint(endpoint: string, apiFormat: ApiFormat) {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { error: 'Enter a valid endpoint URL.' } as const;
  }

  if (url.protocol !== 'https:') {
    return { error: 'Only public HTTPS endpoints are supported.' } as const;
  }
  if (url.username || url.password || (url.port && url.port !== '443')) {
    return { error: 'URL credentials and custom ports are not supported.' } as const;
  }
  if (isBlockedHostname(url.hostname)) {
    return { error: 'Local and private-network endpoints are blocked.' } as const;
  }

  const expectedSuffix = apiFormat === 'anthropic' ? '/v1/messages' : '/v1/chat/completions';
  const normalizedPath = url.pathname.replace(/\/+$/, '');
  if (!normalizedPath.endsWith(expectedSuffix)) {
    return { error: `The selected format requires an endpoint ending in ${expectedSuffix}.` } as const;
  }

  url.hash = '';
  return { url } as const;
}

async function readLimitedText(response: Response) {
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (contentLength > MAX_RESPONSE_BYTES) throw new Error('Response too large');
  if (!response.body) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('Response too large');
    }
    text += decoder.decode(value, { stream: true });
  }

  return text + decoder.decode();
}

function parseJson(rawResponse: string) {
  try {
    return JSON.parse(rawResponse) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function numberField(record: Record<string, unknown>, key: string) {
  return typeof record[key] === 'number' ? record[key] : null;
}

function anthropicAnswer(parsed: Record<string, unknown> | null) {
  const content = parsed && Array.isArray(parsed.content) ? parsed.content : [];
  return content
    .filter(
      (block): block is { type: string; text: string } =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string',
    )
    .map((block) => block.text)
    .join('');
}

function openAiAnswer(parsed: Record<string, unknown> | null) {
  const choices = parsed && Array.isArray(parsed.choices) ? parsed.choices : [];
  const firstChoice = choices[0];
  if (typeof firstChoice !== 'object' || firstChoice === null) return '';
  const message = (firstChoice as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null) return '';
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (part): part is { text: string } =>
        typeof part === 'object' &&
        part !== null &&
        typeof (part as { text?: unknown }).text === 'string',
    )
    .map((part) => part.text)
    .join('');
}

function redactSecret(value: string, apiKey: string) {
  return apiKey ? value.split(apiKey).join('[REDACTED]') : value;
}

export async function POST(request: NextRequest) {
  let payload: RequestPayload;
  try {
    payload = (await request.json()) as RequestPayload;
  } catch {
    return noStore({ error: 'Invalid request body.' }, { status: 400 });
  }

  const { apiFormat, endpoint, apiKey, model, prompt } = payload;
  if (
    (apiFormat !== 'anthropic' && apiFormat !== 'openai') ||
    typeof endpoint !== 'string' ||
    typeof apiKey !== 'string' ||
    typeof model !== 'string' ||
    typeof prompt !== 'string'
  ) {
    return noStore(
      { error: 'API format, endpoint, API key, model, and prompt are required.' },
      { status: 400 },
    );
  }

  if (apiKey.length < 8 || apiKey.length > 512 || model.length > 120 || prompt.length > 1_000) {
    return noStore({ error: 'One or more fields have an invalid length.' }, { status: 400 });
  }

  const validated = validateEndpoint(endpoint.trim(), apiFormat);
  if ('error' in validated) return noStore({ error: validated.error }, { status: 400 });

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiFormat === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers.authorization = `Bearer ${apiKey}`;
  }

  try {
    const upstream = await fetch(validated.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        max_tokens: 96,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      }),
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(45_000),
    });

    const rawResponse = redactSecret(await readLimitedText(upstream), apiKey);
    const parsed = parseJson(rawResponse);
    const usage =
      parsed && typeof parsed.usage === 'object' && parsed.usage !== null
        ? (parsed.usage as Record<string, unknown>)
        : {};

    let inputTokens: number | null;
    let cacheCreationInputTokens: number | null;
    let cacheReadInputTokens: number | null;
    let totalInputTokens: number | null;
    let outputTokens: number | null;
    let answer: string;

    if (apiFormat === 'anthropic') {
      inputTokens = numberField(usage, 'input_tokens');
      cacheCreationInputTokens = numberField(usage, 'cache_creation_input_tokens');
      cacheReadInputTokens = numberField(usage, 'cache_read_input_tokens');
      totalInputTokens =
        inputTokens === null
          ? null
          : inputTokens + (cacheCreationInputTokens ?? 0) + (cacheReadInputTokens ?? 0);
      outputTokens = numberField(usage, 'output_tokens');
      answer = anthropicAnswer(parsed);
    } else {
      outputTokens = numberField(usage, 'completion_tokens');
      const reportedPromptTokens = numberField(usage, 'prompt_tokens');
      const reportedTotalTokens = numberField(usage, 'total_tokens');
      totalInputTokens =
        reportedPromptTokens ??
        (reportedTotalTokens !== null && outputTokens !== null
          ? Math.max(0, reportedTotalTokens - outputTokens)
          : null);
      const promptDetails =
        typeof usage.prompt_tokens_details === 'object' && usage.prompt_tokens_details !== null
          ? (usage.prompt_tokens_details as Record<string, unknown>)
          : {};
      cacheReadInputTokens = numberField(promptDetails, 'cached_tokens');
      cacheCreationInputTokens = null;
      inputTokens =
        totalInputTokens === null
          ? null
          : Math.max(0, totalInputTokens - (cacheReadInputTokens ?? 0));
      answer = openAiAnswer(parsed);
    }

    return noStore({
      httpStatus: upstream.status,
      returnedModel: parsed && typeof parsed.model === 'string' ? parsed.model : null,
      inputTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
      totalInputTokens,
      outputTokens,
      requestId:
        upstream.headers.get('x-request-id') ??
        upstream.headers.get('request-id') ??
        upstream.headers.get('anthropic-request-id'),
      answer: redactSecret(answer, apiKey),
      rawResponse,
    });
  } catch (error) {
    return noStore(
      {
        error:
          error instanceof Error && error.message === 'Response too large'
            ? 'The endpoint returned a response larger than this tester allows.'
            : 'The relay could not reach the endpoint. Check the URL and try again.',
      },
      { status: 502 },
    );
  }
}
