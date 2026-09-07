'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { validateBaseUrl } from '@/lib/server/connection';

type Profile = {
  id: string;
  name: string;
  configs: Record<'anthropic' | 'openai', { baseUrl: string }>;
};
export function AssignRunConnection({
  run,
  profiles,
  onAssigned,
}: {
  run: {
    id: string;
    apiType: 'anthropic' | 'openai';
    baseUrl: string;
    modelName: string;
    createdAt: number;
  };
  profiles: Profile[];
  onAssigned: (id: string, profileId: string, name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [targetId, setTargetId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const original = validateBaseUrl(run.baseUrl);
  const candidates = profiles.filter((profile) => {
    const target = validateBaseUrl(profile.configs[run.apiType]?.baseUrl || '');
    return (
      'baseUrl' in target &&
      'baseUrl' in original &&
      target.baseUrl === original.baseUrl
    );
  });
  if (!candidates.length) return null;
  const label = `${run.modelName} · ${new Date(run.createdAt).toISOString()}`;
  async function assign() {
    if (!targetId || busy) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/runs/${run.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profileId: targetId }),
      });
      const data = (await response.json()) as {
        error?: string;
        profileId?: string;
        profileName?: string;
      };
      if (!response.ok)
        throw new Error(data.error || 'Could not assign this run.');
      if (!data.profileId || !data.profileName)
        throw new Error(
          'Unexpected assignment response. Refresh history to verify.',
        );
      onAssigned(run.id, data.profileId, data.profileName);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Could not assign this run.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="w-full text-sm">
      {!open ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={`Assign connection for ${label}`}
          onClick={() => setOpen(true)}
        >
          Assign connection
        </Button>
      ) : (
        <div className="space-y-3 rounded-xl border border-blue-200 bg-blue-50/60 p-3">
          <p>
            Organize this run under a saved connection with the same API type
            and base URL. Results and timestamps stay unchanged. This does not
            verify which API key was used originally.
          </p>
          <label className="grid gap-1.5 font-medium">
            Assign to connection
            <select
              aria-label={`Assign to connection for ${label}`}
              value={targetId}
              onChange={(event) => setTargetId(event.target.value)}
              disabled={busy}
              className="h-10 rounded-lg border border-input bg-background px-3 font-normal"
            >
              <option value="">Choose a saved connection</option>
              {candidates.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </label>
          {error ? (
            <p role="alert" className="text-rose-700">
              {error}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              disabled={!targetId || busy}
              onClick={() => void assign()}
            >
              {busy ? 'Assigning…' : 'Confirm assignment'}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
