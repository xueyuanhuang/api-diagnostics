import { env } from 'cloudflare:workers';
import { NextRequest } from 'next/server';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { noStore, serverError } from '@/lib/server/http';
import { pelicanOutputLimit, PELICAN_MAX_TOKENS } from '@/lib/pelican-test';

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return noStore({ error: 'Sign in to load your preferences.' }, { status: 401 });
  try {
    const object = await env.EVIDENCE.get(`preferences/${encodeURIComponent(user.userId)}/animation.json`);
    const saved = object ? await object.json<{ maxOutputTokens?: number }>() : null;
    return noStore({ maxOutputTokens: pelicanOutputLimit(saved?.maxOutputTokens) ?? PELICAN_MAX_TOKENS });
  } catch (error) { return serverError(error); }
}

export async function PUT(request: NextRequest) {
  const user = await getChatGPTUser();
  if (!user) return noStore({ error: 'Sign in to save your preferences.' }, { status: 401 });
  if (request.headers.get('origin') !== new URL(request.url).origin) return noStore({ error: 'Cross-origin request rejected.' }, { status: 403 });
  let value: unknown;
  try {
    const raw = await request.text();
    if (raw.length > 200) return noStore({ error: 'Invalid output limit.' }, { status: 400 });
    value = JSON.parse(raw).maxOutputTokens;
  } catch { return noStore({ error: 'Invalid output limit.' }, { status: 400 }); }
  const limit = value === undefined ? null : pelicanOutputLimit(value);
  if (limit === null) return noStore({ error: 'Choose a supported output limit.' }, { status: 400 });
  try {
    await env.EVIDENCE.put(`preferences/${encodeURIComponent(user.userId)}/animation.json`, JSON.stringify({ maxOutputTokens: limit }), { httpMetadata: { contentType: 'application/json' } });
    return noStore({ maxOutputTokens: limit });
  } catch (error) { return serverError(error); }
}
