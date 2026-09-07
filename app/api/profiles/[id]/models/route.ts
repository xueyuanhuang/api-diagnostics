import { env } from 'cloudflare:workers';
import { NextRequest } from 'next/server';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { noStore, serverError } from '@/lib/server/http';
import { rememberModels, ModelListError } from '@/lib/server/remember-models';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const user = await getChatGPTUser();
  if (!user)
    return noStore({ error: 'Sign in to save models.' }, { status: 401 });
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin)
    return noStore(
      { error: 'Cross-origin changes are not allowed.' },
      { status: 403 },
    );
  if (!request.headers.get('content-type')?.includes('application/json'))
    return noStore({ error: 'Expected JSON.' }, { status: 415 });
  let payload;
  try {
    payload = await request.json();
  } catch {
    return noStore({ error: 'Invalid JSON.' }, { status: 400 });
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    return noStore({ error: 'Invalid request.' }, { status: 400 });
  try {
    const { id } = await context.params;
    return noStore(await rememberModels(env.DB, user.userId, id, payload));
  } catch (error) {
    if (error instanceof ModelListError)
      return noStore({ error: error.message }, { status: error.status });
    return serverError(error);
  }
}
