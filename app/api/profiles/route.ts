import { env } from 'cloudflare:workers';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { NextRequest } from 'next/server';

import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getDb } from '@/db';
import { connectionProfiles, profileModels } from '@/db/schema';
import { normalizeModels, validateBaseUrl } from '@/lib/server/connection';
import { encryptApiKey } from '@/lib/server/encryption';
import { noStore, serverError } from '@/lib/server/http';

type ProfilePayload = {
  name?: unknown;
  apiType?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
  models?: unknown;
};

function profileInput(payload: ProfilePayload):
  | { error: string }
  | { name: string; apiType: 'anthropic' | 'openai'; baseUrl: string; apiKey: string; models: string[] } {
  const name = typeof payload.name === 'string' ? payload.name.trim() : '';
  const apiType = payload.apiType;
  const baseUrl = typeof payload.baseUrl === 'string' ? payload.baseUrl.trim() : '';
  const apiKey = typeof payload.apiKey === 'string' ? payload.apiKey.trim() : '';
  const models = normalizeModels(payload.models);
  if (!name || name.length > 60) return { error: 'Use a profile name between 1 and 60 characters.' } as const;
  if (apiType !== 'anthropic' && apiType !== 'openai') return { error: 'Choose an API type.' } as const;
  const validated = validateBaseUrl(baseUrl);
  if ('error' in validated) return validated;
  if (apiKey.length < 8 || apiKey.length > 512) return { error: 'Enter a valid API key.' } as const;
  if (!models.length || models.some((model) => model.length > 120)) {
    return { error: 'Add at least one valid model name.' } as const;
  }
  return { name, apiType, baseUrl: validated.baseUrl, apiKey, models } as const;
}

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return noStore({ error: 'Sign in to view saved profiles.' }, { status: 401 });

  try {
    const db = getDb();
    const profiles = await db
      .select({
        id: connectionProfiles.id,
        name: connectionProfiles.name,
        apiType: connectionProfiles.apiType,
        baseUrl: connectionProfiles.baseUrl,
        createdAt: connectionProfiles.createdAt,
        updatedAt: connectionProfiles.updatedAt,
      })
      .from(connectionProfiles)
      .where(eq(connectionProfiles.userId, user.userId))
      .orderBy(desc(connectionProfiles.updatedAt));
    const profileIds = profiles.map((profile) => profile.id);
    const models = profileIds.length
      ? await db
          .select({ profileId: profileModels.profileId, modelName: profileModels.modelName })
          .from(profileModels)
          .where(inArray(profileModels.profileId, profileIds))
          .orderBy(asc(profileModels.createdAt))
      : [];
    return noStore({
      profiles: profiles.map((profile) => ({
        ...profile,
        hasSavedKey: true,
        models: models.filter((model) => model.profileId === profile.id).map((model) => model.modelName),
      })),
    });
  } catch (error) {
    return serverError(error);
  }
}

export async function POST(request: NextRequest) {
  const user = await getChatGPTUser();
  if (!user) return noStore({ error: 'Sign in to save a profile.' }, { status: 401 });

  let payload: ProfilePayload;
  try {
    payload = (await request.json()) as ProfilePayload;
  } catch {
    return noStore({ error: 'Invalid request body.' }, { status: 400 });
  }
  const input = profileInput(payload);
  if ('error' in input) return noStore({ error: input.error }, { status: 400 });

  try {
    const existing = await getDb()
      .select({ id: connectionProfiles.id })
      .from(connectionProfiles)
      .where(and(eq(connectionProfiles.userId, user.userId), eq(connectionProfiles.name, input.name)))
      .limit(1);
    if (existing.length) {
      return noStore({ error: 'A profile with this name already exists.' }, { status: 409 });
    }

    const id = crypto.randomUUID();
    const now = Date.now();
    const encrypted = await encryptApiKey(input.apiKey);
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO connection_profiles (id, user_id, name, api_type, base_url, encrypted_api_key, key_iv, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(id, user.userId, input.name, input.apiType, input.baseUrl, encrypted.encryptedApiKey, encrypted.keyIv, now, now),
      ...input.models.map((model) =>
        env.DB.prepare(
          'INSERT INTO profile_models (id, profile_id, model_name, created_at) VALUES (?, ?, ?, ?)',
        ).bind(crypto.randomUUID(), id, model, now),
      ),
    ]);
    return noStore(
      {
        profile: {
          id,
          name: input.name,
          apiType: input.apiType,
          baseUrl: input.baseUrl,
          models: input.models,
          hasSavedKey: true,
          createdAt: now,
          updatedAt: now,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    return serverError(error);
  }
}
