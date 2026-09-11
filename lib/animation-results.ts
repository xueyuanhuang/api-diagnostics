export type AnimationResult = {
  answer?: string;
  error?: string;
  returnedModel?: string | null;
  outputTokens?: number | null;
  maxOutputTokens?: number | null;
  finishReason?: string | null;
  totalInputTokens?: number | null;
  totalTimeMs?: number | null;
};
export type AnimationSummary = { id: string; savedAt: string; model: string };
export type SavedAnimation = AnimationSummary & { prompt: string; result: AnimationResult };

export function parseAnimation(value: unknown): SavedAnimation | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  const result = input.result as Record<string, unknown> | undefined;
  if (typeof input.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.id) ||
      typeof input.model !== 'string' || !input.model.trim() || input.model.length > 120 ||
      !result || typeof result.answer !== 'string' || !result.answer || result.answer.length > 1_000_000) return null;
  const metric = (name: string) => typeof result[name] === 'number' && Number.isFinite(result[name]) && Number(result[name]) >= 0 ? Number(result[name]) : null;
  return {
    id: input.id, model: input.model.trim(), savedAt: new Date().toISOString(),
    prompt: typeof input.prompt === 'string' ? input.prompt.slice(0, 1000) : '',
    result: {
      answer: result.answer,
      returnedModel: typeof result.returnedModel === 'string' ? result.returnedModel.slice(0, 200) : null,
      finishReason: typeof result.finishReason === 'string' ? result.finishReason.slice(0, 80) : null,
      maxOutputTokens: metric('maxOutputTokens'),
      outputTokens: metric('outputTokens'), totalInputTokens: metric('totalInputTokens'), totalTimeMs: metric('totalTimeMs'),
    },
  };
}
