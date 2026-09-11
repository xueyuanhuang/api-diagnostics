import { env } from 'cloudflare:workers';
import { NextRequest } from 'next/server';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { noStore, serverError } from '@/lib/server/http';
import { readAnimation } from '@/lib/server/animation-store';

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return noStore({ error: 'Sign in to open this animation.' }, { status: 401 });
  const { id } = await context.params;
  try {
    const saved = await readAnimation(env, user.userId, id);
    return saved ? noStore({ saved }) : noStore({ error: 'Animation not found.' }, { status: 404 });
  } catch (error) { return serverError(error); }
}
