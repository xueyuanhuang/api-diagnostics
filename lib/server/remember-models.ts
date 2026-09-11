import { validateBaseUrl, type ApiType } from './connection';

export class ModelListError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

const configSql = `SELECT c.id, c.base_url AS baseUrl, c.model_name AS model
  FROM profile_api_configs c JOIN connection_profiles p ON p.id = c.profile_id
  WHERE p.id = ? AND p.user_id = ? AND c.api_type = ?`;

function normalizedUrl(value: unknown) {
  const result = validateBaseUrl(typeof value === 'string' ? value : '');
  return 'baseUrl' in result ? result.baseUrl : null;
}

export async function rememberModels(
  db: Pick<D1Database, 'prepare'>,
  userId: string,
  profileId: string,
  payload: {
    apiType?: unknown;
    baseUrl?: unknown;
    models?: unknown;
    source?: unknown;
  },
) {
  if (!userId) throw new ModelListError('Sign in to save models.', 401);
  if (payload.apiType !== 'anthropic' && payload.apiType !== 'openai')
    throw new ModelListError('Choose an API type.');
  const apiType: ApiType = payload.apiType;
  const requestedUrl = normalizedUrl(payload.baseUrl);
  if (!requestedUrl) throw new ModelListError('Enter a valid base URL.');
  const args = [profileId, userId, apiType];
  const config = await db
    .prepare(configSql)
    .bind(...args)
    .first<{ id: string; baseUrl: string; model: string }>();
  if (!config)
    throw new ModelListError(
      'Saved API configuration not found. Select your connection and save the profile once before trying again.',
      404,
    );
  if (normalizedUrl(config.baseUrl) !== requestedUrl)
    throw new ModelListError(
      'The base URL changed. Save or reload the connection before adding models.',
      409,
    );

  let rawModels = payload.models;
  if (payload.source === 'history') {
    const history = await db
      .prepare(`SELECT DISTINCT model_name AS model, base_url AS baseUrl
      FROM test_runs WHERE user_id = ? AND profile_id = ? AND api_type = ?`)
      .bind(userId, profileId, apiType)
      .all<{ model: string; baseUrl: string }>();
    rawModels = history.results
      .filter((row) => normalizedUrl(row.baseUrl) === requestedUrl)
      .map((row) => row.model);
  } else if (payload.source !== undefined) {
    throw new ModelListError('Invalid model source.');
  }
  if (
    !Array.isArray(rawModels) ||
    rawModels.some(
      (m) => typeof m !== 'string' || !m.trim() || m.trim().length > 120,
    )
  )
    throw new ModelListError('Use model names between 1 and 120 characters.');
  const models = [
    ...new Set([config.model, ...rawModels.map((m: string) => m.trim())]),
  ];
  if (models.length > 200)
    throw new ModelListError(
      'This API configuration supports 200 saved models. No models were added.',
      409,
    );

  // One atomic, append-only statement: concurrent batches cannot overwrite each other,
  // exceed the existing 200-model limit, or partially add an over-limit list.
  const inserted = await db
    .prepare(`WITH requested AS (
      SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.model') AS model, key AS position
      FROM json_each(?)
    )
    INSERT INTO profile_api_models (id, config_id, model_name, position, created_at)
    SELECT r.id, c.id, r.model,
      COALESCE((SELECT MAX(position) FROM profile_api_models WHERE config_id = c.id), -1) + 1 + r.position, ?
    FROM requested r JOIN profile_api_configs c ON c.id = ?
    JOIN connection_profiles p ON p.id = c.profile_id
    WHERE p.id = ? AND p.user_id = ? AND c.api_type = ? AND c.base_url = ?
      AND (SELECT COUNT(*) FROM (
        SELECT model_name FROM profile_api_models WHERE config_id = c.id
        UNION SELECT model FROM requested
        UNION SELECT c.model_name
      )) <= 200
    ON CONFLICT(config_id, model_name) DO NOTHING`)
    .bind(
      JSON.stringify(
        models.map((model) => ({ id: crypto.randomUUID(), model })),
      ),
      Date.now(),
      config.id,
      profileId,
      userId,
      apiType,
      config.baseUrl,
    )
    .run();
  const current = await db
    .prepare(configSql)
    .bind(...args)
    .first<{ id: string; baseUrl: string; model: string }>();
  if (
    !current ||
    current.id !== config.id ||
    current.baseUrl !== config.baseUrl
  )
    throw new ModelListError(
      'The connection changed. Reload it before trying again.',
      409,
    );
  const stored = await db
    .prepare(
      'SELECT model_name AS model FROM profile_api_models WHERE config_id = ? ORDER BY position, created_at, model_name',
    )
    .bind(config.id)
    .all<{ model: string }>();
  const savedModels = [
    ...new Set([current.model, ...stored.results.map((row) => row.model)]),
  ];
  if (models.some((model) => !savedModels.includes(model)))
    throw new ModelListError(
      'The saved list would exceed 200 models. No models from this request were added; remove unused models first.',
      409,
    );
  return {
    profileId,
    apiType,
    baseUrl: requestedUrl,
    models: savedModels,
    added: inserted.meta.changes,
  };
}
