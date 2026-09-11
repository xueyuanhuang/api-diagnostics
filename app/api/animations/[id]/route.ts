import { env } from 'cloudflare:workers';
import { NextRequest } from 'next/server';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { noStore, serverError } from '@/lib/server/http';
import { assignLegacyAnimationConnection, readAnimation } from '@/lib/server/animation-store';

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return noStore({ error: 'Sign in to open this animation.' }, { status: 401 });
  const { id } = await context.params;
  try {
    const saved = await readAnimation(env, user.userId, id);
    return saved ? noStore({ saved }) : noStore({ error: 'Animation not found.' }, { status: 404 });
  } catch (error) { return serverError(error); }
}


export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return noStore({ error: 'Sign in to label your saved result.' }, { status: 401 });
  if (request.headers.get('origin') !== new URL(request.url).origin) return noStore({ error: 'Open this action from the website.' }, { status: 403 });
  let profileId: unknown;
  try {
    const raw = await request.text();
    if (raw.length > 1000) return noStore({ error: 'Invalid connection.' }, { status: 400 });
    profileId = JSON.parse(raw).profileId;
  } catch { return noStore({ error: 'Choose a connection.' }, { status: 400 }); }
  if (typeof profileId !== 'string' || !profileId || profileId.length > 100) return noStore({ error: 'Choose a connection.' }, { status: 400 });
  const { id } = await context.params;
  try {
    const profile = await env.DB.prepare('SELECT name FROM connection_profiles WHERE id = ? AND user_id = ?').bind(profileId, user.userId).first<{ name: string }>();
    if (!profile) return noStore({ error: 'Connection not found.' }, { status: 404 });
    const saved = await assignLegacyAnimationConnection(env, user.userId, id, profile.name);
    return saved ? noStore({ saved }) : noStore({ error: 'Result not found or its original key is already recorded.' }, { status: 409 });
  } catch (error) { return serverError(error); }
}
