export type OpenRouterTier = 'default' | 'flex';
export function isOpenRouter(baseUrl: string) {
  try {
    return new URL(baseUrl).origin === 'https://openrouter.ai';
  } catch {
    return false;
  }
}
export function openRouterRoute(
  baseUrl: string,
  apiType: string,
  model: string,
  tier: unknown,
) {
  if (tier === undefined || tier === null || tier === '') return null;
  if (
    !isOpenRouter(baseUrl) ||
    !['openai', 'anthropic'].includes(apiType) ||
    !model.startsWith('openai/')
  )
    throw new Error(
      'Standard/Flex comparison requires an OpenRouter connection and an openai/ model.',
    );
  if (tier !== 'default' && tier !== 'flex')
    throw new Error('Choose Standard or Flex.');
  const tag = tier === 'flex' ? 'openai/flex' : 'openai';
  return {
    service_tier: tier,
    provider: {
      only: [tag],
      order: [tag],
      allow_fallbacks: false,
      require_parameters: true,
    },
    reasoning: { effort: 'low' },
  };
}
export function routeEvidence(
  requestBody?: string | null,
  rawResponse?: string | null,
) {
  let requested: string | null = null;
  let served: string | null = null;
  let provider: string | null = null;
  let cost: number | null = null;
  try {
    requested = JSON.parse(requestBody || '{}').service_tier ?? null;
  } catch {
    /* Old evidence may be incomplete. */
  }
  const candidates = [
    rawResponse || '',
    ...(rawResponse || '')
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim()),
  ];
  for (const candidate of candidates) {
    try {
      const event = JSON.parse(candidate);
      if (typeof event.service_tier === 'string') served = event.service_tier;
      if (typeof event.provider === 'string') provider = event.provider;
      if (
        typeof event.usage?.cost === 'number' &&
        Number.isFinite(event.usage.cost)
      )
        cost = event.usage.cost;
    } catch {
      /* Ignore SSE framing and incomplete events. */
    }
  }
  return { requested, served, provider, cost };
}
