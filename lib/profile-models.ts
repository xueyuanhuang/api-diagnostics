type ModelConfig = { model: string; models: string[] };

export function mergeModelLists(...lists: string[][]): string[] {
  return [...new Set(lists.flat().map(model => model.trim()).filter(Boolean))];
}

// Only the model catalog is shared. URLs, keys and defaults belong to each format.
export function shareProfileModels<T extends ModelConfig>(
  configs: Record<'anthropic' | 'openai', T>,
  models = mergeModelLists(
    [configs.anthropic.model], configs.anthropic.models,
    [configs.openai.model], configs.openai.models,
  ),
): Record<'anthropic' | 'openai', T> {
  const apply = (config: T): T => ({
    ...config,
    model: models.includes(config.model) ? config.model : models[0] ?? '',
    models,
  });
  return { anthropic: apply(configs.anthropic), openai: apply(configs.openai) };
}
