import { getChatGPTUser } from '@/app/chatgpt-auth';
import { type ApiType, validateBaseUrl } from './connection';
import { decryptApiKey } from './encryption';
import { getOwnedProfileConfig } from './profile-config';

export type RequestPayload = {
  profileId?: unknown;
  apiType?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
  model?: unknown;
};

export async function resolveTestConnection(payload: RequestPayload) {
  const model = typeof payload.model === 'string' ? payload.model.trim() : '';
  if (!model || model.length > 120)
    return { error: 'Enter a valid model name.' } as const;

  if (typeof payload.profileId === 'string' && payload.profileId) {
    const user = await getChatGPTUser();
    if (!user)
      return {
        error: 'Sign in again to use this saved profile.',
        status: 401,
      } as const;
    let requestedApiType: ApiType | undefined;
    if (payload.apiType === undefined || payload.apiType === null) {
      requestedApiType = undefined;
    } else if (
      payload.apiType === 'anthropic' ||
      payload.apiType === 'openai'
    ) {
      requestedApiType = payload.apiType;
    } else {
      return { error: 'Choose a valid API type.', status: 400 } as const;
    }
    const config = await getOwnedProfileConfig({
      userId: user.userId,
      profileId: payload.profileId,
      apiType: requestedApiType,
      requestedModel: model,
      allowModelOverride: true,
    });
    if (!config)
      return {
        error: 'Saved profile, API type, or model not found.',
        status: 404,
      } as const;
    return {
      apiType: config.apiType,
      baseUrl: config.baseUrl,
      apiKey: await decryptApiKey(config.encryptedApiKey, config.keyIv),
      model,
    } as const;
  }

  const apiType = payload.apiType;
  const baseUrl =
    typeof payload.baseUrl === 'string' ? payload.baseUrl.trim() : '';
  const apiKey =
    typeof payload.apiKey === 'string' ? payload.apiKey.trim() : '';
  if (apiType !== 'anthropic' && apiType !== 'openai')
    return { error: 'Choose an API type.' } as const;
  const validated = validateBaseUrl(baseUrl);
  if ('error' in validated) return validated;
  if (apiKey.length < 8 || apiKey.length > 512)
    return { error: 'Enter a valid API key.' } as const;
  return { apiType, baseUrl: validated.baseUrl, apiKey, model } as const;
}
