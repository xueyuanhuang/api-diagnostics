import { and, asc, eq } from 'drizzle-orm';

import { getDb } from '@/db';
import {
  connectionProfiles,
  profileApiConfigs,
  profileApiModels,
  profileModels,
} from '@/db/schema';
import type { ApiType } from '@/lib/server/connection';
import { mergeModelLists } from '@/lib/profile-models';

export type OwnedProfileConfig = {
  profileId: string;
  profileName: string;
  apiType: ApiType;
  baseUrl: string;
  modelName: string;
  models: string[];
  encryptedApiKey: string;
  keyIv: string;
};

export async function getOwnedProfileConfig({
  userId,
  profileId,
  apiType,
  requestedModel,
  allowModelOverride = false,
}: {
  userId: string;
  profileId: string;
  apiType?: ApiType;
  requestedModel?: string;
  allowModelOverride?: boolean;
}): Promise<OwnedProfileConfig | null> {
  const db = getDb();
  const profiles = await db
    .select({
      id: connectionProfiles.id,
      name: connectionProfiles.name,
      apiType: connectionProfiles.apiType,
      baseUrl: connectionProfiles.baseUrl,
      encryptedApiKey: connectionProfiles.encryptedApiKey,
      keyIv: connectionProfiles.keyIv,
    })
    .from(connectionProfiles)
    .where(
      and(
        eq(connectionProfiles.id, profileId),
        eq(connectionProfiles.userId, userId),
      ),
    )
    .limit(1);
  if (!profiles.length) return null;

  const profile = profiles[0];
  const resolvedApiType = apiType ?? (profile.apiType as ApiType);
  const configs = await db
    .select({
      id: profileApiConfigs.id,
      apiType: profileApiConfigs.apiType,
      baseUrl: profileApiConfigs.baseUrl,
      modelName: profileApiConfigs.modelName,
      encryptedApiKey: profileApiConfigs.encryptedApiKey,
      keyIv: profileApiConfigs.keyIv,
    })
    .from(profileApiConfigs)
    .where(eq(profileApiConfigs.profileId, profileId));
  const modelRows = await db
      .select({ modelName: profileApiModels.modelName })
      .from(profileApiModels)
      .innerJoin(profileApiConfigs, eq(profileApiModels.configId, profileApiConfigs.id))
      .where(eq(profileApiConfigs.profileId, profileId))
      .orderBy(asc(profileApiModels.position));
  const legacyRows = await db
    .select({ modelName: profileModels.modelName })
    .from(profileModels)
    .where(eq(profileModels.profileId, profileId))
    .orderBy(asc(profileModels.createdAt));
  const models = mergeModelLists(
    configs.map(config => config.modelName),
    modelRows.map(row => row.modelName),
    legacyRows.map(row => row.modelName),
  );
  if (requestedModel && !allowModelOverride && !models.includes(requestedModel)) return null;

  const config = configs.find(item => item.apiType === resolvedApiType);
  if (config) {
    return {
      profileId,
      profileName: profile.name,
      apiType: resolvedApiType,
      baseUrl: config.baseUrl,
      modelName: requestedModel || config.modelName,
      models,
      encryptedApiKey: config.encryptedApiKey,
      keyIv: config.keyIv,
    };
  }

  // Legacy profiles have one stored configuration. Until the owner next saves
  // the profile, expose that configuration through both API formats.
  return {
    profileId,
    profileName: profile.name,
    apiType: resolvedApiType,
    baseUrl: profile.baseUrl,
    modelName: requestedModel || legacyRows[0]?.modelName || models[0] || '',
    models,
    encryptedApiKey: profile.encryptedApiKey,
    keyIv: profile.keyIv,
  };
}
