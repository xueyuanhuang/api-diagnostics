import {
  type ApiType,
  normalizeModels,
  validateBaseUrl,
} from '@/lib/server/connection';

export const API_TYPES = ['anthropic', 'openai'] as const;

export type ProfileConfigInput = {
  baseUrl: string;
  model: string;
  models: string[];
  apiKey: string;
};

export type ParsedProfileInput = {
  name: string;
  defaultApiType: ApiType;
  configs: Partial<Record<ApiType, ProfileConfigInput>>;
  legacyPayload: boolean;
};

function record(value: unknown) {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function apiType(value: unknown): ApiType | null {
  return value === 'anthropic' || value === 'openai' ? value : null;
}

function configInput(value: unknown): ProfileConfigInput | { error: string } {
  const input = record(value);
  if (!input) return { error: 'Both API type configurations are required.' };
  const rawBaseUrl =
    typeof input.baseUrl === 'string' ? input.baseUrl.trim() : '';
  const validated = validateBaseUrl(rawBaseUrl);
  if ('error' in validated) return validated;
  const requestedModel =
    typeof input.model === 'string' ? input.model.trim() : '';
  const models = [
    ...new Set(
      [requestedModel, ...normalizeModels(input.models)].filter(Boolean),
    ),
  ].slice(0, 20);
  const model = requestedModel || models[0] || '';
  if (
    !model ||
    model.length > 120 ||
    models.some((item) => item.length > 120)
  ) {
    return { error: 'Add at least one valid model name for each API type.' };
  }
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  if (apiKey && (apiKey.length < 8 || apiKey.length > 512)) {
    return { error: 'Enter a valid API key.' };
  }
  return {
    baseUrl: validated.baseUrl,
    model,
    models,
    apiKey,
  };
}

export function parseProfileInput(
  payload: Record<string, unknown>,
): ParsedProfileInput | { error: string } {
  const name = typeof payload.name === 'string' ? payload.name.trim() : '';
  if (!name || name.length > 60) {
    return { error: 'Use a profile name between 1 and 60 characters.' };
  }
  const defaultApiType = apiType(payload.defaultApiType ?? payload.apiType);
  if (!defaultApiType) return { error: 'Choose an API type.' };

  const rawConfigs = record(payload.configs);
  if (rawConfigs) {
    const anthropic = configInput(rawConfigs.anthropic);
    if ('error' in anthropic) return anthropic;
    const openai = configInput(rawConfigs.openai);
    if ('error' in openai) return openai;
    return {
      name,
      defaultApiType,
      configs: { anthropic, openai },
      legacyPayload: false,
    };
  }

  const legacy = configInput({
    baseUrl: payload.baseUrl,
    model: normalizeModels(payload.models)[0],
    models: payload.models,
    apiKey: payload.apiKey,
  });
  if ('error' in legacy) return legacy;
  return {
    name,
    defaultApiType,
    configs: { [defaultApiType]: legacy },
    legacyPayload: true,
  };
}
