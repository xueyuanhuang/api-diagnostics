import { NextRequest, NextResponse } from 'next/server';

const ALLOWED_ENDPOINT = 'https://inference-api.worldrouter.ai/v1/messages';

type RequestPayload = {
  endpoint?: unknown;
  apiKey?: unknown;
  model?: unknown;
  prompt?: unknown;
};

function noStore<T>(body: T, init?: ResponseInit) {
  const response = NextResponse.json(body, init);
  response.headers.set('Cache-Control', 'no-store, max-age=0');
  response.headers.set('Pragma', 'no-cache');
  return response;
}

export async function POST(request: NextRequest) {
  let payload: RequestPayload;
  try {
    payload = (await request.json()) as RequestPayload;
  } catch {
    return noStore({ error: 'Invalid request body.' }, { status: 400 });
  }

  const { endpoint, apiKey, model, prompt } = payload;
  if (
    typeof endpoint !== 'string' ||
    typeof apiKey !== 'string' ||
    typeof model !== 'string' ||
    typeof prompt !== 'string'
  ) {
    return noStore({ error: 'Endpoint, API key, model, and prompt are required.' }, { status: 400 });
  }

  if (endpoint !== ALLOWED_ENDPOINT) {
    return noStore(
      { error: 'For safety, this public relay only accepts the WorldRouter Messages endpoint.' },
      { status: 400 },
    );
  }

  if (apiKey.length < 8 || apiKey.length > 512 || model.length > 120 || prompt.length > 1_000) {
    return noStore({ error: 'One or more fields have an invalid length.' }, { status: 400 });
  }

  try {
    const upstream = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 96,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      }),
      cache: 'no-store',
    });

    const rawResponse = await upstream.text();
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(rawResponse) as Record<string, unknown>;
    } catch {
      parsed = null;
    }

    const usage =
      parsed && typeof parsed.usage === 'object' && parsed.usage !== null
        ? (parsed.usage as Record<string, unknown>)
        : {};
    const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : null;
    const cacheCreation =
      typeof usage.cache_creation_input_tokens === 'number'
        ? usage.cache_creation_input_tokens
        : null;
    const cacheRead =
      typeof usage.cache_read_input_tokens === 'number'
        ? usage.cache_read_input_tokens
        : null;
    const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : null;
    const totalInputTokens =
      inputTokens !== null && cacheCreation !== null && cacheRead !== null
        ? inputTokens + cacheCreation + cacheRead
        : null;

    const content = parsed && Array.isArray(parsed.content) ? parsed.content : [];
    const answer = content
      .filter(
        (block): block is { type: string; text: string } =>
          typeof block === 'object' &&
          block !== null &&
          (block as { type?: unknown }).type === 'text' &&
          typeof (block as { text?: unknown }).text === 'string',
      )
      .map((block) => block.text)
      .join('');

    return noStore({
      httpStatus: upstream.status,
      returnedModel: parsed && typeof parsed.model === 'string' ? parsed.model : null,
      inputTokens,
      cacheCreationInputTokens: cacheCreation,
      cacheReadInputTokens: cacheRead,
      totalInputTokens,
      outputTokens,
      requestId:
        upstream.headers.get('x-request-id') ??
        upstream.headers.get('request-id') ??
        upstream.headers.get('anthropic-request-id'),
      answer,
      rawResponse,
    });
  } catch {
    return noStore(
      { error: 'The relay could not reach the endpoint. Try again in a moment.' },
      { status: 502 },
    );
  }
}
