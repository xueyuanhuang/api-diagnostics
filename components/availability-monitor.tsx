'use client';
import {
  OpenRouterSelector,
  useOpenRouterTier,
  selectedRoute,
} from '@/components/openrouter-selector';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertDialog } from '@base-ui/react/alert-dialog';
import { Activity, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { confirmHttpRisk, isInsecureHttp } from '@/lib/http-consent';
import { activeConnectionId } from '@/lib/saved-connections';
import {
  historySlots,
  targetHealth,
  PROBE_INTERVAL_MS,
  type AvailabilityData,
} from '@/lib/availability';

type ApiType = 'anthropic' | 'openai';
type MonitorProfile = {
  id: string;
  name: string;
  defaultApiType: ApiType;
  configs: Record<
    ApiType,
    { baseUrl: string; model: string; models: string[]; hasSavedKey: boolean }
  >;
};
const healthColors: Record<string, string> = {
  ok: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  failing: 'border-rose-200 bg-rose-50 text-rose-700',
  checking: 'border-blue-200 bg-blue-50 text-blue-700',
  unknown: 'border-slate-200 bg-slate-50 text-slate-600',
};
const barColors: Record<string, string> = {
  ok: 'bg-[#70a89e] hover:bg-[#4a8c80]',
  failing: 'bg-[#d66c86] hover:bg-[#b94b67]',
  checking: 'bg-blue-400 animate-pulse',
  unknown: 'bg-slate-200 hover:bg-slate-300',
};

export function AvailabilityMonitor({
  signedIn,
  signInPath,
  profiles,
  active,
  onConnections,
}: {
  signedIn: boolean;
  signInPath: string;
  profiles: MonitorProfile[];
  active: boolean;
  onConnections: () => void;
}) {
  const [data, setData] = useState<AvailabilityData | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [pendingRemoval, setPendingRemoval] = useState<{
    id: string;
    modelName: string;
    profileName: string;
    apiType: ApiType;
  } | null>(null);
  const [removalError, setRemovalError] = useState('');
  const cancelRemovalRef = useRef<HTMLButtonElement>(null);
  const removalTriggerRef = useRef<HTMLButtonElement>(null);
  const refreshButtonRef = useRef<HTMLButtonElement>(null);
  const [profileId, setProfileId] = useState('');
  const preferredLoaded = useRef(false);
  useEffect(() => {
    if (preferredLoaded.current || !profiles.length) return;
    preferredLoaded.current = true;
    const id = activeConnectionId();
    if (profiles.some((item) => item.id === id)) setProfileId(id);
  }, [profiles]);
  const [chosenApiType, setApiType] = useState<ApiType | null>(null);
  const [clock, setClock] = useState(0);
  const [receivedAt, setReceivedAt] = useState(0);
  const [tier, setTier] = useOpenRouterTier();
  const [model, setModel] = useState('');
  const [filter, setFilter] = useState('');
  const [onlyFailing, setOnlyFailing] = useState(false);
  const [inspected, setInspected] = useState<{
    id: string;
    slot: number;
  } | null>(null);
  const profile = profiles.find((item) => item.id === profileId) ?? profiles[0];
  const apiType = chosenApiType ?? profile?.defaultApiType ?? 'anthropic';
  const config = profile?.configs[apiType];
  const models = [
    ...new Set(
      [config?.model, ...(config?.models ?? [])].filter(
        (name): name is string => Boolean(name),
      ),
    ),
  ];
  const selectedModel = models.includes(model) ? model : (models[0] ?? '');

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch('/api/availability', {
        cache: 'no-store',
        signal,
      });
      const result = (await response.json()) as AvailabilityData & {
        error?: string;
      };
      if (!response.ok)
        throw new Error(result.error || 'Could not load availability targets.');
      const received = Date.now();
      setReceivedAt(received);
      setClock(received);
      setData(result);
    } catch (cause) {
      if (!signal?.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : 'Could not load availability targets.',
        );
    }
  }, []);
  useEffect(() => {
    if (!signedIn) return;
    if (!active) return;
    const controller = new AbortController();
    const initialLoad = setTimeout(() => void refresh(controller.signal), 0);
    const timer = setInterval(() => {
      setClock(Date.now());
      if (document.visibilityState === 'visible')
        void refresh(controller.signal);
    }, 15_000);
    return () => {
      controller.abort();
      clearTimeout(initialLoad);
      clearInterval(timer);
    };
  }, [signedIn, active, refresh]);

  async function add() {
    if (!profile || !selectedModel || busy) return;
    if (
      !confirmHttpRisk([config!.baseUrl], (message) => window.confirm(message))
    )
      return;
    setBusy('add');
    setError('');
    try {
      const response = await fetch('/api/availability', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profileId: profile.id,
          apiType,
          model: selectedModel,
          openRouterTier: selectedRoute(config!.baseUrl, selectedModel, tier),
          allowInsecureHttp: isInsecureHttp(config!.baseUrl),
        }),
      });
      const result = (await response.json()) as AvailabilityData & {
        error?: string;
      };
      if (!response.ok)
        throw new Error(result.error || 'Could not add target.');
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not add target. Refresh before retrying.',
      );
      await refresh();
    } finally {
      setBusy('');
    }
  }
  async function togglePause(id: string, paused: boolean) {
    if (busy) return;
    setBusy(id);
    try {
      const response = await fetch(
        `/api/availability/${encodeURIComponent(id)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paused }),
        },
      );
      const result = (await response.json()) as { error?: string };
      if (!response.ok)
        throw new Error(result.error || 'Could not update target.');
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not update target.',
      );
    } finally {
      setBusy('');
    }
  }
  async function remove() {
    if (busy || !pendingRemoval) return;
    const { id } = pendingRemoval;
    setBusy(id);
    setRemovalError('');
    try {
      const response = await fetch(
        `/api/availability/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      );
      const result = (await response.json()) as AvailabilityData & {
        error?: string;
      };
      if (!response.ok)
        throw new Error(result.error || 'Could not remove target.');
      setData((current) =>
        current
          ? {
              ...current,
              targets: current.targets.filter((target) => target.id !== id),
            }
          : current,
      );
      if (inspected?.id === id) setInspected(null);
      setPendingRemoval(null);
    } catch (cause) {
      setRemovalError(
        cause instanceof Error ? cause.message : 'Could not remove target.',
      );
    } finally {
      setBusy('');
    }
  }
  const now = data ? data.serverTime + clock - receivedAt : clock;
  const targets = data?.targets ?? [];
  const visible = targets.filter(
    (target) =>
      (!onlyFailing || targetHealth(target, now).status === 'failing') &&
      `${target.modelName} ${target.profileName} ${target.baseUrl}`
        .toLowerCase()
        .includes(filter.toLowerCase()),
  );
  const schedulerLive = Boolean(
    data?.scheduler.lastTickAt &&
    now - data.scheduler.lastTickAt < 2 * PROBE_INTERVAL_MS,
  );
  const selectedTarget = targets.find((target) => target.id === inspected?.id);
  const selectedSample = selectedTarget?.samples.find(
    (sample) => sample.slotStart === inspected?.slot,
  );

  return (
    <section className="space-y-5" aria-label="Availability Monitor">
      <div className="rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              <Activity className="size-4" /> Always-on checks
            </div>
            <h2 className="text-2xl font-semibold tracking-tight">
              Availability Monitor
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
              Choose a saved connection and model. A short “Reply with only OK”
              request checks availability every 10 minutes, even when this page
              is closed.
            </p>
          </div>
          <Badge
            variant="outline"
            className={schedulerLive ? healthColors.ok : healthColors.unknown}
          >
            {schedulerLive
              ? 'Background checks active'
              : data?.scheduler.configured
                ? 'Waiting for scheduler'
                : signedIn
                  ? 'Loading monitor…'
                  : 'Sign-in required'}
          </Badge>
        </div>
        {!signedIn ? (
          <div className="mt-5 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-950">
            <a
              className="font-semibold underline"
              href={signInPath}
              target="_top"
            >
              Sign in with Google
            </a>{' '}
            to use saved connections and keep your probe targets and history
            private.
          </div>
        ) : (
          <>
            <div className="mt-6 grid items-end gap-3 md:grid-cols-[1fr_180px_1fr_auto]">
              <label className="space-y-2 text-xs font-medium">
                Connection
                <select
                  value={profile?.id ?? ''}
                  onChange={(event) => {
                    setProfileId(event.target.value);
                    setApiType(
                      profiles.find((item) => item.id === event.target.value)
                        ?.defaultApiType ?? 'anthropic',
                    );
                    setModel('');
                  }}
                  disabled={Boolean(busy)}
                  className="block h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
                >
                  <option value="" disabled>
                    Select a saved connection
                  </option>
                  {profiles.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-2 text-xs font-medium">
                API type
                <select
                  value={apiType}
                  onChange={(event) => {
                    setApiType(event.target.value as ApiType);
                    setModel('');
                  }}
                  disabled={Boolean(busy)}
                  className="block h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
                >
                  <option value="anthropic">Messages</option>
                  <option value="openai">Chat Completions</option>
                </select>
              </label>
              <label className="space-y-2 text-xs font-medium">
                Model
                <select
                  value={selectedModel}
                  onChange={(event) => setModel(event.target.value)}
                  disabled={Boolean(busy)}
                  className="block h-10 w-full rounded-lg border border-input bg-background px-3 font-mono text-xs"
                >
                  <option value="" disabled>
                    Select a saved model
                  </option>
                  {models.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <OpenRouterSelector
                baseUrl={config?.baseUrl ?? ''}
                model={selectedModel}
                tier={tier}
                onChange={setTier}
                disabled={Boolean(busy)}
              />
              <Button
                type="button"
                onClick={() => void add()}
                disabled={
                  Boolean(busy) ||
                  !profile ||
                  !selectedModel ||
                  !data?.scheduler.configured
                }
                className="h-10 gap-2"
              >
                <Plus className="size-4" />
                {busy === 'add' ? 'Adding & checking…' : 'Add target'}
              </Button>
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs leading-5 text-muted-foreground">
              <p>
                One small request per target per interval. Adding starts the
                first check. Removing stops future checks.
              </p>
              <Button
                type="button"
                variant="link"
                size="sm"
                onClick={onConnections}
              >
                Manage saved connections
              </Button>
            </div>
            {data?.scheduler.configured && !schedulerLive && (
              <p className="mt-3 text-xs text-amber-800">
                {data.scheduler.lastTickAt
                  ? 'Background checks are delayed. Grey intervals mean no completed check, not a model failure.'
                  : 'The scheduler is starting. Your first check runs when you add a target.'}
              </p>
            )}
          </>
        )}
        {error && (
          <p
            role="alert"
            className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700"
          >
            {error}
          </p>
        )}
      </div>

      {signedIn && (
        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border p-5">
            <div>
              <h3 className="text-lg font-semibold">Probe targets</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Latest status and the last 4 hours. Click a history bar to
                inspect a check.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <label htmlFor="availability-filter" className="relative">
                <Search className="absolute left-3 top-3 size-4 text-muted-foreground" />
                <Input
                  id="availability-filter"
                  aria-label="Filter targets"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder="Filter by model or connection"
                  className="h-10 w-64 pl-9 text-xs"
                />
              </label>
              <label className="flex items-center gap-2 text-xs font-medium">
                <input
                  type="checkbox"
                  checked={onlyFailing}
                  onChange={(event) => setOnlyFailing(event.target.checked)}
                  className="size-4 accent-primary"
                />
                Only failing
              </label>
              <Badge variant="secondary">{targets.length} targets</Badge>
              <Button
                ref={refreshButtonRef}
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setError('');
                  void refresh();
                }}
                aria-label="Refresh status"
              >
                <RefreshCw className="size-4" />
              </Button>
            </div>
          </div>
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40">
                <TableHead className="pl-5">Model / connection</TableHead>
                <TableHead>Cadence</TableHead>
                <TableHead>Health</TableHead>
                <TableHead>Last check</TableHead>
                <TableHead className="min-w-72">Health history</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((target) => {
                const health = targetHealth(target, now);
                const latest = target.samples.at(-1);
                return (
                  <TableRow key={target.id} className="h-28">
                    <TableCell className="max-w-80 pl-5">
                      <p className="break-all font-semibold">
                        {target.modelName}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {target.profileName} ·{' '}
                        {target.apiType === 'anthropic'
                          ? 'Messages'
                          : 'Chat Completions'}
                      </p>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {target.paused ? 'Paused' : 'Every 10 min'}
                      <button
                        className="mt-2 block underline"
                        disabled={Boolean(busy)}
                        onClick={() => togglePause(target.id, !target.paused)}
                      >
                        {target.paused ? 'Resume' : 'Pause'}
                      </button>
                    </TableCell>
                    <TableCell className="max-w-80">
                      <Badge
                        variant="outline"
                        className={healthColors[health.status]}
                      >
                        {health.label}
                      </Badge>
                      {latest?.error && (
                        <p
                          className="mt-2 line-clamp-2 text-xs text-rose-700"
                          title={latest.error}
                        >
                          {latest.error}
                        </p>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {latest ? (
                        <>
                          <p>
                            {new Date(latest.startedAt).toLocaleTimeString()}
                          </p>
                          <p className="mt-1">
                            {latest.httpStatus
                              ? `HTTP ${latest.httpStatus}`
                              : '—'}
                            {latest.latencyMs !== null
                              ? ` · ${(latest.latencyMs / 1000).toFixed(2)}s`
                              : ''}
                          </p>
                        </>
                      ) : (
                        'Not checked yet'
                      )}
                    </TableCell>
                    <TableCell>
                      <div
                        className="flex min-w-64 gap-1"
                        aria-label={`Health history for ${target.modelName}`}
                      >
                        {historySlots(target, now).map((slot) => (
                          <button
                            key={slot.slotStart}
                            type="button"
                            title={slot.label}
                            aria-label={slot.label}
                            disabled={!slot.sample}
                            onClick={() =>
                              setInspected({
                                id: target.id,
                                slot: slot.slotStart,
                              })
                            }
                            className={`h-8 min-w-1 flex-1 rounded-[3px] transition-colors disabled:cursor-default ${barColors[slot.status]} ${inspected?.id === target.id && inspected.slot === slot.slotStart ? 'ring-2 ring-primary ring-offset-2' : ''}`}
                          />
                        ))}
                      </div>
                      <div className="mt-2 flex justify-between text-[10px] text-muted-foreground">
                        <span>4h ago</span>
                        <span>10m each · now</span>
                      </div>
                    </TableCell>
                    <TableCell className="pr-5">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={Boolean(busy)}
                        aria-label={`Remove ${target.modelName} on ${target.profileName}`}
                        aria-haspopup="dialog"
                        onClick={(event) => {
                          removalTriggerRef.current = event.currentTarget;
                          setRemovalError('');
                          setPendingRemoval({
                            id: target.id,
                            modelName: target.modelName,
                            profileName: target.profileName,
                            apiType: target.apiType,
                          });
                        }}
                        className="text-muted-foreground hover:text-rose-700"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
              {!visible.length && (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="h-36 text-center text-sm text-muted-foreground"
                  >
                    {!data
                      ? 'Loading probe targets…'
                      : targets.length
                        ? 'No targets match this filter.'
                        : profiles.length
                          ? 'No targets yet. Choose a connection and model above to start monitoring.'
                          : 'Save a connection and model first, then add a probe target here.'}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-muted/20 px-5 py-3 text-[11px] text-muted-foreground">
            <span>
              Green: usable response · Red: request failed · Blue: checking ·
              Grey: unknown / no check
            </span>
            <span>
              {data?.scheduler.lastTickAt
                ? `Scheduler last seen ${new Date(data.scheduler.lastTickAt).toLocaleTimeString()}`
                : 'Awaiting scheduler contact'}
            </span>
          </div>
        </div>
      )}

      {selectedTarget && selectedSample && (
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">
                {selectedTarget.modelName} · check details
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {selectedTarget.profileName} ·{' '}
                {new Date(selectedSample.startedAt).toLocaleString()}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setInspected(null)}
            >
              Close
            </Button>
          </div>
          <dl className="my-4 grid gap-3 text-xs sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground">Result</dt>
              <dd className="mt-1 font-medium">
                {selectedSample.status} · HTTP{' '}
                {selectedSample.httpStatus ?? '—'}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Returned model</dt>
              <dd className="mt-1 break-all font-mono">
                {selectedSample.returnedModel ?? '—'}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Request ID</dt>
              <dd className="mt-1 break-all font-mono">
                {selectedSample.requestId ?? '—'}
              </dd>
            </div>
          </dl>
          <p className="whitespace-pre-wrap break-words rounded-lg bg-muted/50 p-3 text-sm">
            {selectedSample.error ||
              selectedSample.answer ||
              'No completed response recorded.'}
          </p>
        </div>
      )}
      <AlertDialog.Root
        open={pendingRemoval !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setPendingRemoval(null);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-slate-950/40" />
          <AlertDialog.Popup
            initialFocus={cancelRemovalRef}
            finalFocus={() =>
              removalTriggerRef.current?.isConnected
                ? removalTriggerRef.current
                : refreshButtonRef.current
            }
            className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-card p-6 text-card-foreground shadow-xl outline-none"
          >
            <AlertDialog.Title className="text-lg font-semibold">
              Remove this probe target?
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-sm leading-6 text-muted-foreground">
              Availability checks every 10 minutes will stop for this model and
              connection.
            </AlertDialog.Description>
            <div className="my-4 rounded-xl bg-muted/50 p-3 text-sm">
              <p className="break-words font-semibold">
                {pendingRemoval?.modelName}
              </p>
              <p className="mt-1 break-words text-muted-foreground">
                {pendingRemoval?.profileName} ·{' '}
                {pendingRemoval?.apiType === 'anthropic'
                  ? 'Messages'
                  : 'Chat Completions'}
              </p>
            </div>
            {removalError && (
              <p role="alert" className="mb-4 text-sm text-rose-700">
                {removalError}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                ref={cancelRemovalRef}
                type="button"
                variant="outline"
                disabled={Boolean(busy)}
                onClick={() => setPendingRemoval(null)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={Boolean(busy)}
                onClick={() => void remove()}
              >
                {busy ? 'Removing…' : 'Remove target'}
              </Button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </section>
  );
}
