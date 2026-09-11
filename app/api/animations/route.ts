import { env } from 'cloudflare:workers';
import { NextRequest } from 'next/server';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { noStore, serverError } from '@/lib/server/http';
import { listAnimations, saveAnimation } from '@/lib/server/animation-store';
import { parseAnimation } from '@/lib/animation-results';

export async function GET(request: NextRequest) {
  const user = await getChatGPTUser();
  if (!user) return noStore({ error: 'Sign in to view saved animations.' }, { status: 401 });
  const before = request.nextUrl.searchParams.get('before');
  try {
    const results = await listAnimations(env, user.userId, before);
    return noStore({ results, nextBefore: results.length === 100 ? `${Date.parse(results[results.length - 1].savedAt)}:${results[results.length - 1].id}` : null });
  } catch (error) { return serverError(error); }
}

export async function POST(request: NextRequest) {
  const user = await getChatGPTUser();
  if (!user) return noStore({ error: 'Sign in to save this animation.' }, { status: 401 });
  let animation;
  try {
    const raw = await request.text();
    if (raw.length > 2_000_000) return noStore({ error: 'Animation is too large to save.' }, { status: 413 });
    animation = parseAnimation(JSON.parse(raw));
  } catch { return noStore({ error: 'Invalid animation.' }, { status: 400 }); }
  if (!animation) return noStore({ error: 'Invalid animation.' }, { status: 400 });
  try { return noStore({ saved: await saveAnimation(env, user.userId, animation) }); }
  catch (error) { return serverError(error); }
}
