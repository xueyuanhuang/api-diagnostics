import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getDb } from '@/db';
import { connectionProfiles } from '@/db/schema';
import { normalizeModels, validateBaseUrl } from '@/lib/server/connection';
import { encryptApiKey } from '@/lib/server/encryption';
import { noStore, serverError } from '@/lib/server/http';

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, context: Context) {
  const user = await getChatGPTUser();
  if (!user) return noStore({ error: 'Sign in to update a profile.' }, { status: 401 });
  const { id } = await context.params;

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return noStore({ error: 'Invalid request body.' }, { status: 400 });
  }

  const name = typeof payload.name === 'string' ? payload.name.trim() : '';
  const apiType = payload.apiType;
  const rawBaseUrl = typeof payload.baseUrl === 'string' ? payload.baseUrl.trim() : '';
  const apiKey = typeof payload.apiKey === 'string' ? payload.apiKey.trim() : '';
  const models = normalizeModels(payload.models);
  if (!name || name.length > 60) return noStore({ error: 'Use a valid profile name.' }, { status: 400 });
  if (apiType !== 'anthropic' && apiType !== 'openai') return noStore({ error: 'Choose an API type.' }, { status: 400 });
  const validated = validateBaseUrl(rawBaseUrl);
  if ('error' in validated) return noStore({ error: validated.error }, { status: 400 });
  if (!models.length || models.some((model) => model.length > 120)) {
    return noStore({ error: 'Add at least one valid model name.' }, { status: 400 });
  }
  if (apiKey && (apiKey.length < 8 || apiKey.length > 512)) {
    return noStore({ error: 'Enter a valid replacement API key.' }, { status: 400 });
  }

  try {
    const existing = await getDb()
      .select({ encryptedApiKey: connectionProfiles.encryptedApiKey, keyIv: connectionProfiles.keyIv })
      .from(connectionProfiles)
      .where(and(eq(connectionProfiles.id, id), eq(connectionProfiles.userId, user.userId)))
      .limit(1);
    if (!existing.length) return noStore({ error: 'Profile not found.' }, { status: 404 });

    const encrypted = apiKey ? await encryptApiKey(apiKey) : existing[0];
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        'UPDATE connection_profiles SET name = ?, api_type = ?, base_url = ?, encrypted_api_key = ?, key_iv = ?, updated_at = ? WHERE id = ? AND user_id = ?',
      ).bind(name, apiType, validated.baseUrl, encrypted.encryptedApiKey, encrypted.keyIv, now, id, user.userId),
      env.DB.prepare('DELETE FROM profile_models WHERE profile_id = ?').bind(id),
      ...models.map((model) =>
        env.DB.prepare(
          'INSERT INTO profile_models (id, profile_id, model_name, created_at) VALUES (?, ?, ?, ?)',
        ).bind(crypto.randomUUID(), id, model, now),
      ),
    ]);
    return noStore({
      profile: {
        id,
        name,
        apiType,
        baseUrl: validated.baseUrl,
        models,
        hasSavedKey: true,
        updatedAt: now,
      },
    });
  } catch (error) {
    return serverError(error);
  }
}

export async function DELETE(_request: NextRequest, context: Context) {
  const user = await getChatGPTUser();
  if (!user) return noStore({ error: 'Sign in to delete a profile.' }, { status: 401 });
  const { id } = await context.params;
  try {
    const result = await env.DB.prepare('DELETE FROM connection_profiles WHERE id = ? AND user_id = ?')
      .bind(id, user.userId)
      .run();
    if (!result.meta.changes) return noStore({ error: 'Profile not found.' }, { status: 404 });
    return noStore({ deleted: true });
  } catch (error) {
    return serverError(error);
  }
}
