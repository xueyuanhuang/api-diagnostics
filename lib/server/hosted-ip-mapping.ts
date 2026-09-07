import { env } from 'cloudflare:workers';
import {
  IpMappingError,
  isRawIpv4,
  mappingTarget,
  resolveIpConnection,
  type ResolvedConnection,
} from './ip-mapping';

function config() {
  const values = env as unknown as Record<string, string | undefined>;
  if (values.IP_MAPPING_SUFFIX !== 'ip-api.xyhmail.xyz')
    throw new IpMappingError(
      'IP mapping must use the approved ip-api.xyhmail.xyz namespace. Contact the site owner.',
    );
  return {
    token: values.CF_DNS_API_TOKEN,
    zoneId: values.CF_DNS_ZONE_ID,
    suffix: values.IP_MAPPING_SUFFIX,
  };
}

export function resolveHostedConnection(
  baseUrl: string,
  authenticated: boolean,
) {
  return resolveIpConnection(
    baseUrl,
    authenticated,
    isRawIpv4(baseUrl) && authenticated ? config() : {},
  );
}

export async function prepareRpmConnection(runId: string, baseUrl: string) {
  const resolved = await resolveHostedConnection(baseUrl, true);
  const saved = await env.EVIDENCE.put(
    `rpm/v1/${runId}/connection.json`,
    JSON.stringify(resolved),
    {
      httpMetadata: { contentType: 'application/json' },
      onlyIf: { etagDoesNotMatch: '*' },
    },
  );
  return saved ? resolved : loadRpmConnection(runId, baseUrl);
}

// Only read the mapping frozen before preflight. No DNS provisioning in timed shards.
export async function loadRpmConnection(
  runId: string,
  baseUrl: string,
): Promise<ResolvedConnection> {
  if (!isRawIpv4(baseUrl))
    return { originalBaseUrl: baseUrl, actualBaseUrl: baseUrl, mapping: null };
  const object = await env.EVIDENCE.get(`rpm/v1/${runId}/connection.json`);
  const resolved = object ? await object.json<ResolvedConnection>() : null;
  const target = mappingTarget(baseUrl, config().suffix || '');
  if (
    !resolved ||
    resolved.originalBaseUrl !== baseUrl.replace(/\/$/, '') ||
    resolved.actualBaseUrl !== target?.actualBaseUrl
  )
    throw new IpMappingError(
      'The preflight IP mapping is missing or changed. Start a new RPM run; no ramp requests were sent.',
    );
  return resolved;
}
