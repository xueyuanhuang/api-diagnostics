import { env } from 'cloudflare:workers';
import { asc, desc, eq, inArray } from 'drizzle-orm';
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

type ProfileConfigResponse = {
  baseUrl: string;
  model: string;
  models: string[];
  hasSavedKey: true;
};

async function loadInBatches<T>(
  ids: string[],
  load: (batch: string[]) => Promise<T[]>,
) {
  const rows: T[] = [];
  for (let offset = 0; offset < ids.length; offset += 50) {
    rows.push(...(await load(ids.slice(offset, offset + 50))));
  }
  return rows;
}

function valueRows(rowCount: number, columnCount: number) {
  const row = `(${Array.from({ length: columnCount }, () => '?').join(', ')})`;
  return Array.from({ length: rowCount }, () => row).join(', ');
}

function publicProfile({
  id,
  name,
  defaultApiType,
  configs,
  createdAt,
  updatedAt,
}: {
  id: string;
  name: string;
  defaultApiType: 'anthropic' | 'openai';
  configs: Record<'anthropic' | 'openai', ProfileConfigResponse>;
  createdAt: number;
  updatedAt: number;
}) {
  const defaultConfig = configs[defaultApiType];
  return {
    id,
    name,
    defaultApiType,
    configs,
    // Transitional aliases keep an already-open older client functional.
    apiType: defaultApiType,
    baseUrl: defaultConfig.baseUrl,
    models: defaultConfig.models,
    hasSavedKey: true,
    createdAt,
    updatedAt,
  };
}

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) {
    return noStore(
      { error: 'Sign in to view saved profiles.' },
      { status: 401 },
    );
  }

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
    const legacyModels = await loadInBatches(profileIds, (batch) =>
      db
        .select({
          profileId: profileModels.profileId,
          modelName: profileModels.modelName,
        })
        .from(profileModels)
        .where(inArray(profileModels.profileId, batch))
        .orderBy(asc(profileModels.createdAt)),
    );
    const storedConfigs = await loadInBatches(profileIds, (batch) =>
      db
        .select({
          id: profileApiConfigs.id,
          profileId: profileApiConfigs.profileId,
          apiType: profileApiConfigs.apiType,
          baseUrl: profileApiConfigs.baseUrl,
          modelName: profileApiConfigs.modelName,
        })
        .from(profileApiConfigs)
        .where(inArray(profileApiConfigs.profileId, batch)),
    );
    const configIds = storedConfigs.map((config) => config.id);
    const storedModels = await loadInBatches(configIds, (batch) =>
      db
        .select({
          configId: profileApiModels.configId,
          modelName: profileApiModels.modelName,
        })
        .from(profileApiModels)
        .where(inArray(profileApiModels.configId, batch))
        .orderBy(asc(profileApiModels.position)),
    );

    return noStore({
      profiles: profiles.map((profile) => {
        const fallbackModels = legacyModels
          .filter((model) => model.profileId === profile.id)
          .map((model) => model.modelName);
        const configs = Object.fromEntries(
          API_TYPES.map((type) => {
            const stored = storedConfigs.find(
              (config) =>
                config.profileId === profile.id && config.apiType === type,
            );
            if (!stored) {
              return [
                type,
                {
                  baseUrl: profile.baseUrl,
                  model: fallbackModels[0] ?? '',
                  models: fallbackModels,
                  hasSavedKey: true,
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
                baseUrl: stored.baseUrl,
                model: stored.modelName,
                models,
                hasSavedKey: true,
              },
            ];
          }),
        ) as Record<'anthropic' | 'openai', ProfileConfigResponse>;
        return publicProfile({
          id: profile.id,
          name: profile.name,
          defaultApiType: profile.apiType,
          configs,
          createdAt: profile.createdAt,
          updatedAt: profile.updatedAt,
        });
      }),
    });
  } catch (error) {
    return serverError(error);
  }
}

export async function POST(request: NextRequest) {
  const user = await getChatGPTUser();
  if (!user) {
    return noStore({ error: 'Sign in to save a profile.' }, { status: 401 });
  }

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

  const supplied = parsed.configs.anthropic ?? parsed.configs.openai ?? null;
  if (!supplied) {
    return noStore(
      { error: 'Add connection details for at least one API type.' },
      { status: 400 },
    );
  }
  const rawConfigs = Object.fromEntries(
    API_TYPES.map((type) => [type, parsed.configs[type] ?? supplied]),
  ) as Record<'anthropic' | 'openai', ProfileConfigInput>;
  const firstKey = rawConfigs.anthropic.apiKey || rawConfigs.openai.apiKey;
  if (!firstKey) {
    return noStore(
      { error: 'Enter an API key before saving a new profile.' },
      { status: 400 },
    );
  }
  const configs = {
    anthropic: { ...rawConfigs.anthropic },
    openai: { ...rawConfigs.openai },
  };
  if (!configs.anthropic.apiKey) configs.anthropic.apiKey = firstKey;
  if (!configs.openai.apiKey) configs.openai.apiKey = firstKey;

  try {
    const duplicateName = await env.DB.prepare(
      'SELECT id FROM connection_profiles WHERE user_id = ? AND name = ? LIMIT 1',
    )
      .bind(user.userId, parsed.name)
      .first();
    if (duplicateName) {
      return noStore(
        { error: 'A profile with this name already exists.' },
        { status: 409 },
      );
    }

    const id = crypto.randomUUID();
    const now = Date.now();
    const encryptedEntries = await Promise.all(
      API_TYPES.map(
        async (type) =>
          [type, await encryptApiKey(configs[type].apiKey)] as const,
      ),
    );
    const encrypted = Object.fromEntries(encryptedEntries) as Record<
      'anthropic' | 'openai',
      { encryptedApiKey: string; keyIv: string }
    >;
    const configIds = {
      anthropic: crypto.randomUUID(),
      openai: crypto.randomUUID(),
    };
    const defaultConfig = configs[parsed.defaultApiType];
    const defaultEncrypted = encrypted[parsed.defaultApiType];
    const legacyModelValues = defaultConfig.models.flatMap((model) => [
      crypto.randomUUID(),
      id,
      model,
      now,
    ]);
    const configValues = API_TYPES.flatMap((type) => [
      configIds[type],
      id,
      type,
      configs[type].baseUrl,
      configs[type].model,
      encrypted[type].encryptedApiKey,
      encrypted[type].keyIv,
      now,
      now,
    ]);
    const apiModelStatements = API_TYPES.map((type) => {
      const values = configs[type].models.flatMap((model, position) => [
        crypto.randomUUID(),
        configIds[type],
        model,
        position,
        now,
      ]);
      return env.DB.prepare(
        `INSERT INTO profile_api_models (id, config_id, model_name, position, created_at) VALUES ${valueRows(configs[type].models.length, 5)}`,
      ).bind(...values);
    });

    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO connection_profiles (id, user_id, name, api_type, base_url, encrypted_api_key, key_iv, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(
        id,
        user.userId,
        parsed.name,
        parsed.defaultApiType,
        defaultConfig.baseUrl,
        defaultEncrypted.encryptedApiKey,
        defaultEncrypted.keyIv,
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO profile_models (id, profile_id, model_name, created_at) VALUES ${valueRows(defaultConfig.models.length, 4)}`,
      ).bind(...legacyModelValues),
      env.DB.prepare(
        `INSERT INTO profile_api_configs (id, profile_id, api_type, base_url, model_name, encrypted_api_key, key_iv, created_at, updated_at) VALUES ${valueRows(API_TYPES.length, 9)}`,
      ).bind(...configValues),
      ...apiModelStatements,
    ]);

    const responseConfigs = Object.fromEntries(
      API_TYPES.map((type) => [
        type,
        {
          baseUrl: configs[type].baseUrl,
          model: configs[type].model,
          models: configs[type].models,
          hasSavedKey: true,
        },
      ]),
    ) as Record<'anthropic' | 'openai', ProfileConfigResponse>;
    return noStore(
      {
        profile: publicProfile({
          id,
          name: parsed.name,
          defaultApiType: parsed.defaultApiType,
          configs: responseConfigs,
          createdAt: now,
          updatedAt: now,
        }),
      },
      { status: 201 },
    );
  } catch (error) {
    return serverError(error);
  }
}
