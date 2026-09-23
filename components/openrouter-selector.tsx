'use client';
import { useEffect, useState } from 'react';
import { isOpenRouter, type OpenRouterTier } from '@/lib/openrouter';
const key = 'api-diagnostics-openrouter-tier';
export function useOpenRouterTier() {
  const [tier, setTier] = useState<OpenRouterTier>('default');
  useEffect(() => {
    const sync = () => {
      try {
        setTier(localStorage.getItem(key) === 'flex' ? 'flex' : 'default');
      } catch {}
    };
    sync();
    window.addEventListener('openrouter-tier', sync);
    return () => window.removeEventListener('openrouter-tier', sync);
  }, []);
  return [
    tier,
    (value: OpenRouterTier) => {
      setTier(value);
      try {
        localStorage.setItem(key, value);
      } catch {}
      window.dispatchEvent(new Event('openrouter-tier'));
    },
  ] as const;
}
export function selectedRoute(
  baseUrl: string,
  model: string,
  tier: OpenRouterTier,
) {
  return isOpenRouter(baseUrl) && model.startsWith('openai/')
    ? tier
    : undefined;
}
export function OpenRouterSelector({
  baseUrl,
  model,
  tier,
  onChange,
  disabled = false,
}: {
  baseUrl: string;
  model: string;
  tier: OpenRouterTier;
  onChange: (tier: OpenRouterTier) => void;
  disabled?: boolean;
}) {
  if (!isOpenRouter(baseUrl) || !model.startsWith('openai/')) return null;
  return (
    <div className="my-3 space-y-2 rounded-xl border border-border p-3">
      <label className="text-sm font-medium">
        OpenRouter resource{' '}
        <select
          aria-label="OpenRouter resource"
          className="ml-3 rounded-lg border bg-background p-2"
          value={tier}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value as OpenRouterTier)}
        >
          <option value="default">OpenAI · Standard</option>
          <option value="flex">OpenAI · Flex (discounted)</option>
        </select>
      </label>
      <p className="text-xs text-muted-foreground">
        Shared across tests on this browser. Requests pin the selected route
        with fallback disabled. Availability and pricing depend on the model.
        Saved runs and monitors retain the route used when started.
      </p>
    </div>
  );
}
