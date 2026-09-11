import { env } from 'cloudflare:workers';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { NextRequest } from 'next/server';

import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getDb } from '@/db';
import {
  connectionProfiles,
  profileApiConfigs,
  profileApiModels,
  profileModels,
} from '@/db/schema';
import { encryptApiKey } from '@/lib/server/encryption';
import { noStore, serverError } from '@/lib/server/http';
import {
  API_TYPES,
  parseProfileInput,
  type ProfileConfigInput,
} from '@/lib/server/profile-input';

type Context = { params: Promise<{ id: string }> };
type ApiType = (typeof API_TYPES)[number];
type ExistingConfig = {
  id: string | null;
  baseUrl: string;
  model: string;
  models: string[];
  encryptedApiKey: string;
  keyIv: string;
  createdAt: number;
};

function valueRows(rowCount: number, columnCount: number) {
  const row = `(${Array.from({ length: columnCount }, () => '?').join(', ')})`;
  return Array.from({ length: rowCount }, () => row).join(', ');
}

export async function PATCH(request: NextRequest, context: Context) {
  const user = await getChatGPTUser();
  if (!user) {
    return noStore({ error: 'Sign in to update a profile.' }, { status: 401 });
  }
  const { id } = await context.params;

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return noStore({ error: 'Invalid request body.' }, { status: 400 });
  }
  const parsed = parseProfileInput(payload);
  if ('error' in parsed) {
    return noStore({ error: parsed.error }, { status: 400 });
  }

  try {
    const db = getDb();
    const profiles = await db
      .select({
        id: connectionProfiles.id,
        baseUrl: connectionProfiles.baseUrl,
        encryptedApiKey: connectionProfiles.encryptedApiKey,
        keyIv: connectionProfiles.keyIv,
        createdAt: connectionProfiles.createdAt,
      })
      .from(connectionProfiles)
      .where(
        and(
          eq(connectionProfiles.id, id),
          eq(connectionProfiles.userId, user.userId),
        ),
      )
      .limit(1);
    if (!profiles.length) {
      return noStore({ error: 'Profile not found.' }, { status: 404 });
    }
    const duplicateName = await env.DB.prepare(
      'SELECT id FROM connection_profiles WHERE user_id = ? AND name = ? AND id != ? LIMIT 1',
    )
      .bind(user.userId, parsed.name, id)
      .first();
    if (duplicateName) {
      return noStore(
        { error: 'A profile with this name already exists.' },
        { status: 409 },
      );
    }

    const profile = profiles[0];
    const storedConfigs = await db
      .select({
        id: profileApiConfigs.id,
        apiType: profileApiConfigs.apiType,
        baseUrl: profileApiConfigs.baseUrl,
        modelName: profileApiConfigs.modelName,
        encryptedApiKey: profileApiConfigs.encryptedApiKey,
        keyIv: profileApiConfigs.keyIv,
        createdAt: profileApiConfigs.createdAt,
      })
      .from(profileApiConfigs)
      .where(eq(profileApiConfigs.profileId, id));
    const configIds = storedConfigs.map((config) => config.id);
    const storedModels = configIds.length
      ? await db
          .select({
            configId: profileApiModels.configId,
            modelName: profileApiModels.modelName,
          })
          .from(profileApiModels)
          .where(inArray(profileApiModels.configId, configIds))
          .orderBy(asc(profileApiModels.position))
      : [];
    const legacyModels = await db
      .select({ modelName: profileModels.modelName })
      .from(profileModels)
      .where(eq(profileModels.profileId, id))
      .orderBy(asc(profileModels.createdAt));
    const fallbackModels = legacyModels.map((model) => model.modelName);

    const existing = Object.fromEntries(
      API_TYPES.map((type) => {
        const stored = storedConfigs.find((config) => config.apiType === type);
        if (!stored) {
          return [
            type,
            {
              id: null,
              baseUrl: profile.baseUrl,
              model: fallbackModels[0] ?? '',
              models: fallbackModels,
              encryptedApiKey: profile.encryptedApiKey,
              keyIv: profile.keyIv,
              createdAt: profile.createdAt,
            },
          ];
        }
        const models = [
          ...new Set([
            stored.modelName,
            ...storedModels
              .filter((model) => model.configId === stored.id)
              .map((model) => model.modelName),
          ]),
        ];
        return [
          type,
          {
            id: stored.id,
            baseUrl: stored.baseUrl,
            model: stored.modelName,
            models,
            encryptedApiKey: stored.encryptedApiKey,
            keyIv: stored.keyIv,
            createdAt: stored.createdAt,
          },
        ];
      }),
    ) as Record<ApiType, ExistingConfig>;

    const incoming = Object.fromEntries(
      API_TYPES.map((type) => [type, parsed.configs[type] ?? existing[type]]),
    ) as Record<ApiType, ProfileConfigInput | ExistingConfig>;
    const encryptedEntries = await Promise.all(
      API_TYPES.map(async (type) => {
        const replacement =
          'apiKey' in incoming[type] ? incoming[type].apiKey : '';
        return [
          type,
          replacement
            ? await encryptApiKey(replacement)
            : {
                encryptedApiKey: existing[type].encryptedApiKey,
                keyIv: existing[type].keyIv,
              },
        ] as const;
      }),
    );
    const encrypted = Object.fromEntries(encryptedEntries) as Record<
      ApiType,
      { encryptedApiKey: string; keyIv: string }
    >;
    const configs = Object.fromEntries(
      API_TYPES.map((type) => [
        type,
        {
          baseUrl: incoming[type].baseUrl,
          model: incoming[type].model,
          models: incoming[type].models,
          encryptedApiKey: encrypted[type].encryptedApiKey,
          keyIv: encrypted[type].keyIv,
        },
      ]),
    ) as Record<ApiType, Omit<ExistingConfig, 'id' | 'createdAt'>>;
    const ids = {
      anthropic: existing.anthropic.id ?? crypto.randomUUID(),
      openai: existing.openai.id ?? crypto.randomUUID(),
    };
    const now = Date.now();
    const defaultConfig = configs[parsed.defaultApiType];
    const legacyModelValues = defaultConfig.models.map((model) => [
      crypto.randomUUID(),
      id,
      model,
      now,
    ]);
    const configValues = API_TYPES.flatMap((type) => [
      ids[type],
      id,
      type,
      configs[type].baseUrl,
      configs[type].model,
      configs[type].encryptedApiKey,
      configs[type].keyIv,
      existing[type].createdAt,
      now,
    ]);
    const apiModelStatements = API_TYPES.map((type) => {
      const values = configs[type].models.map((model, position) => [
        crypto.randomUUID(),
        ids[type],
        model,
        position,
        now,
      ]);
      return env.DB.prepare(
        `INSERT INTO profile_api_models (id, config_id, model_name, position, created_at) SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]') FROM json_each(?)`,
      ).bind(JSON.stringify(values));
    });

    await env.DB.batch([
      env.DB.prepare(
        'UPDATE connection_profiles SET name = ?, api_type = ?, base_url = ?, encrypted_api_key = ?, key_iv = ?, updated_at = ? WHERE id = ? AND user_id = ?',
      ).bind(
        parsed.name,
        parsed.defaultApiType,
        defaultConfig.baseUrl,
        defaultConfig.encryptedApiKey,
        defaultConfig.keyIv,
        now,
        id,
        user.userId,
      ),
      env.DB.prepare('DELETE FROM profile_models WHERE profile_id = ?').bind(
        id,
      ),
      env.DB.prepare(
        `INSERT INTO profile_models (id, profile_id, model_name, created_at) SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]') FROM json_each(?)`,
      ).bind(JSON.stringify(legacyModelValues)),
      env.DB.prepare(
        `INSERT INTO profile_api_configs (id, profile_id, api_type, base_url, model_name, encrypted_api_key, key_iv, created_at, updated_at) VALUES ${valueRows(API_TYPES.length, 9)} ON CONFLICT(profile_id, api_type) DO UPDATE SET base_url = excluded.base_url, model_name = excluded.model_name, encrypted_api_key = excluded.encrypted_api_key, key_iv = excluded.key_iv, updated_at = excluded.updated_at`,
      ).bind(...configValues),
      env.DB.prepare(
        'DELETE FROM profile_api_models WHERE config_id IN (?, ?)',
      ).bind(ids.anthropic, ids.openai),
      ...apiModelStatements,
    ]);

    return noStore({
      profile: {
        id,
        name: parsed.name,
        defaultApiType: parsed.defaultApiType,
        configs: Object.fromEntries(
          API_TYPES.map((type) => [
            type,
            {
              baseUrl: configs[type].baseUrl,
              model: configs[type].model,
              models: configs[type].models,
              hasSavedKey: true,
            },
          ]),
        ) as Record<
          ApiType,
          {
            baseUrl: string;
            model: string;
            models: string[];
            hasSavedKey: true;
          }
        >,
        apiType: parsed.defaultApiType,
        baseUrl: defaultConfig.baseUrl,
        models: defaultConfig.models,
        hasSavedKey: true,
        createdAt: profile.createdAt,
        updatedAt: now,
      },
    });
  } catch (error) {
    return serverError(error);
  }
}

export async function DELETE(_request: NextRequest, context: Context) {
  const user = await getChatGPTUser();
  if (!user) {
    return noStore({ error: 'Sign in to delete a profile.' }, { status: 401 });
  }
  const { id } = await context.params;
  try {
    const result = await env.DB.prepare(
      'DELETE FROM connection_profiles WHERE id = ? AND user_id = ?',
    )
      .bind(id, user.userId)
      .run();
    if (!result.meta.changes) {
      return noStore({ error: 'Profile not found.' }, { status: 404 });
    }
    return noStore({ deleted: true });
  } catch (error) {
    return serverError(error);
  }
}
