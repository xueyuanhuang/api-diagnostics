import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const connectionProfiles = sqliteTable(
  'connection_profiles',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    name: text('name').notNull(),
    apiType: text('api_type', { enum: ['anthropic', 'openai'] }).notNull(),
    baseUrl: text('base_url').notNull(),
    encryptedApiKey: text('encrypted_api_key').notNull(),
    keyIv: text('key_iv').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('profiles_user_name_unique').on(table.userId, table.name),
    index('profiles_user_updated_idx').on(table.userId, table.updatedAt),
  ],
);

export const profileModels = sqliteTable(
  'profile_models',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => connectionProfiles.id, { onDelete: 'cascade' }),
    modelName: text('model_name').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('profile_models_profile_name_unique').on(
      table.profileId,
      table.modelName,
    ),
    index('profile_models_profile_idx').on(table.profileId),
  ],
);

export const profileApiConfigs = sqliteTable(
  'profile_api_configs',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => connectionProfiles.id, { onDelete: 'cascade' }),
    apiType: text('api_type', { enum: ['anthropic', 'openai'] }).notNull(),
    baseUrl: text('base_url').notNull(),
    modelName: text('model_name').notNull(),
    encryptedApiKey: text('encrypted_api_key').notNull(),
    keyIv: text('key_iv').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('profile_api_configs_profile_type_unique').on(
      table.profileId,
      table.apiType,
    ),
    index('profile_api_configs_profile_idx').on(table.profileId),
  ],
);

export const profileApiModels = sqliteTable(
  'profile_api_models',
  {
    id: text('id').primaryKey(),
    configId: text('config_id')
      .notNull()
      .references(() => profileApiConfigs.id, { onDelete: 'cascade' }),
    modelName: text('model_name').notNull(),
    position: integer('position').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('profile_api_models_config_name_unique').on(
      table.configId,
      table.modelName,
    ),
    index('profile_api_models_config_idx').on(table.configId),
  ],
);

export const testRuns = sqliteTable(
  'test_runs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    profileId: text('profile_id').references(() => connectionProfiles.id, {
      onDelete: 'set null',
    }),
    profileName: text('profile_name'),
    apiType: text('api_type', { enum: ['anthropic', 'openai'] }).notNull(),
    baseUrl: text('base_url').notNull(),
    modelName: text('model_name').notNull(),
    verdict: text('verdict').notNull(),
    normalCount: integer('normal_count').notNull(),
    cacheCount: integer('cache_count').notNull(),
    largeCount: integer('large_count').notNull(),
    errorCount: integer('error_count').notNull(),
    unavailableCount: integer('unavailable_count').notNull().default(0),
    medianTtftMs: integer('median_ttft_ms'),
    medianGenerationMs: integer('median_generation_ms'),
    medianTotalTimeMs: integer('median_total_time_ms'),
    medianOutputTokensPerSecond: real('median_output_tokens_per_second'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('runs_user_created_idx').on(table.userId, table.createdAt)],
);

export const testResults = sqliteTable(
  'test_results',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => testRuns.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    questionId: text('question_id').notNull(),
    category: text('category').notNull(),
    prompt: text('prompt').notNull(),
    status: text('status').notNull(),
    httpStatus: integer('http_status'),
    returnedModel: text('returned_model'),
    inputTokens: integer('input_tokens'),
    cacheCreationInputTokens: integer('cache_creation_input_tokens'),
    cacheReadInputTokens: integer('cache_read_input_tokens'),
    totalInputTokens: integer('total_input_tokens'),
    outputTokens: integer('output_tokens'),
    ttftMs: integer('ttft_ms'),
    generationMs: integer('generation_ms'),
    totalTimeMs: integer('total_time_ms'),
    outputTokensPerSecond: real('output_tokens_per_second'),
    requestMethod: text('request_method'),
    requestUrl: text('request_url'),
    requestHeaders: text('request_headers'),
    requestBody: text('request_body'),
    responseHeaders: text('response_headers'),
    requestId: text('request_id'),
    answer: text('answer'),
    rawResponse: text('raw_response'),
    error: text('error'),
  },
  (table) => [
    uniqueIndex('results_run_position_unique').on(table.runId, table.position),
    index('results_run_idx').on(table.runId),
  ],
);
