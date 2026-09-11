import { validateBaseUrl } from './connection';

export class IpMappingError extends Error {
  constructor(
    message: string,
    public status = 503,
  ) {
    super(message);
    this.name = 'IpMappingError';
  }
}

export type IpMappingConfig = {
  token?: string;
  zoneId?: string;
  suffix?: string;
  existingOnly?: boolean;
};

export type ResolvedConnection = {
  originalBaseUrl: string;
  actualBaseUrl: string;
  mapping: null | { hostname: string; address: string; verifiedAt: string };
};

export function isRawIpv4(baseUrl: string) {
  return /^\d+\.\d+\.\d+\.\d+$/.test(new URL(baseUrl).hostname);
}

export function mappingTarget(baseUrl: string, suffix: string) {
  const checked = validateBaseUrl(baseUrl);
  if ('error' in checked) throw new IpMappingError(checked.error, 400);
  const url = new URL(checked.baseUrl);
  if (!isRawIpv4(checked.baseUrl)) return null;
  if (url.protocol !== 'http:')
    throw new IpMappingError(
      'Automatic IP mapping supports HTTP origins only. For HTTPS, use the provider hostname matching its TLS certificate; HTTPS is never downgraded.',
      400,
    );
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(suffix))
    throw new IpMappingError(
      'IP mapping is not configured correctly. Contact the site owner.',
    );
  const address = url.hostname;
  const hostname = `${address.replaceAll('.', '-')}.${suffix}`;
  url.hostname = hostname;
  return {
    address,
    hostname,
    actualBaseUrl: url.toString().replace(/\/$/, ''),
  };
}

type DnsRecord = {
  type: string;
  name: string;
  content: string;
  proxied: boolean;
};

async function dnsJson(response: Response, service: string) {
  // Workers only supports manual/follow. Manual also prevents credential forwarding.
  if (response.status >= 300 && response.status < 400) {
    try {
      await response.body?.cancel();
    } catch {
      // Cleanup failure must not hide the rejected redirect.
    }
    throw new IpMappingError(
      `${service} refused a redirect (HTTP ${response.status}). No provider request was sent. Contact the site owner.`,
    );
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new IpMappingError(
      `${service} returned invalid JSON (HTTP ${response.status}). No provider request was sent.`,
    );
  }
  if (!json || typeof json !== 'object' || Array.isArray(json))
    throw new IpMappingError(
      `${service} returned an unexpected response (HTTP ${response.status}). No provider request was sent.`,
    );
  return json;
}

// No provider key is accepted by this function. Only the DNS credential is sent to Cloudflare.
export async function resolveIpConnection(
  baseUrl: string,
  authenticated: boolean,
  config: IpMappingConfig,
  request: typeof fetch = fetch,
  sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
): Promise<ResolvedConnection> {
  const checked = validateBaseUrl(baseUrl);
  if ('error' in checked) throw new IpMappingError(checked.error, 400);
  const unchanged = {
    originalBaseUrl: checked.baseUrl,
    actualBaseUrl: checked.baseUrl,
    mapping: null,
  };
  if (!isRawIpv4(checked.baseUrl)) return unchanged;
  if (!authenticated)
    throw new IpMappingError(
      'Sign in to use automatic public-IP mapping.',
      401,
    );
  const target = mappingTarget(checked.baseUrl, config.suffix || '');
  if (!target || (!config.existingOnly && (!config.token || !/^[a-f0-9]{32}$/.test(config.zoneId || ''))))
    throw new IpMappingError(
      'Automatic IP mapping is not available. Contact the site owner.',
    );

  const apiUrl = `https://api.cloudflare.com/client/v4/zones/${config.zoneId}/dns_records`;
  const preparationDeadline = AbortSignal.timeout(20_000);
  async function dnsApi(url: string, body?: unknown) {
    try {
      const response = await request(url, {
        method: body ? 'POST' : 'GET',
        headers: {
          authorization: `Bearer ${config.token}`,
          'content-type': 'application/json',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'manual',
        signal: AbortSignal.any([
          preparationDeadline,
          AbortSignal.timeout(8_000),
        ]),
      });
      const json = (await dnsJson(response, 'DNS mapping service')) as {
        success: boolean;
        result: DnsRecord[] | DnsRecord;
        result_info?: { total_pages?: number };
        errors?: { code?: number }[];
      };
      if (!response.ok || json.success !== true)
        throw new IpMappingError(
          `DNS mapping service rejected the request (HTTP ${response.status}, code ${Number(json.errors?.[0]?.code) || 'unknown'}). No provider request was sent.`,
        );
      return json;
    } catch (error) {
      if (error instanceof IpMappingError) throw error;
      // Never expose the DNS response, token, or fetch exception to clients/logs.
      throw new IpMappingError(
        'DNS mapping service could not be reached. No provider request was sent; try again later.',
      );
    }
  }
  async function records() {
    const data = await dnsApi(
      `${apiUrl}?name=${encodeURIComponent(target!.hostname)}&per_page=100`,
    );
    if (!Array.isArray(data.result) || (data.result_info?.total_pages || 1) > 1)
      throw new IpMappingError(
        'DNS mapping could not be verified. No records were changed.',
      );
    return data.result;
  }
  function verifyRecords(items: DnsRecord[]) {
    if (
      !items.length ||
      items.some(
        (record) =>
          record.name !== target!.hostname ||
          record.type !== 'A' ||
          record.content !== target!.address ||
          record.proxied !== false,
      )
    )
      throw new IpMappingError(
        'The automatic hostname conflicts with an existing DNS record. Nothing was overwritten; contact the site owner.',
      );
  }

  if (!config.existingOnly) {
  const existing = await records();
  if (existing.length) verifyRecords(existing);
  else {
    try {
      const created = await dnsApi(apiUrl, {
        type: 'A',
        name: target.hostname,
        content: target.address,
        proxied: false,
        ttl: 60,
        comment: 'Normal Token Check automatic public-IP mapping',
      });
      verifyRecords([created.result as DnsRecord]);
    } catch (creationError) {
      // Concurrent first requests may create the same record; reuse only an exact match.
      const raced = await records();
      if (!raced.length) throw creationError;
      verifyRecords(raced);
    }
  }

  }

  let resolved = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(attempt * 1_000);
    try {
      const response = await request(
        `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(target.hostname)}&type=A`,
        {
          headers: { accept: 'application/dns-json' },
          redirect: 'manual',
          signal: AbortSignal.any([
            preparationDeadline,
            AbortSignal.timeout(5_000),
          ]),
        },
      );
      const dns = (await dnsJson(response, 'DNS resolver')) as {
        Status: number;
        Answer?: { type: number; data: string }[];
      };
      const answers = dns.Answer || [];
      resolved =
        response.ok &&
        dns.Status === 0 &&
        answers.some((a) => a.type === 1 && a.data === target.address) &&
        answers.every(
          (a) => a.type !== 5 && (a.type !== 1 || a.data === target.address),
        );
      if (resolved) break;
    } catch (error) {
      if (error instanceof IpMappingError) throw error;
      /* Bounded retry for propagation; never send to an unverified mapping. */
    }
  }
  if (!resolved)
    throw new IpMappingError(
      'The IP hostname was reserved but DNS is not ready yet. No provider request was sent. Wait a minute and retry.',
    );
  return {
    originalBaseUrl: checked.baseUrl,
    actualBaseUrl: target.actualBaseUrl,
    mapping: {
      hostname: target.hostname,
      address: target.address,
      verifiedAt: new Date().toISOString(),
    },
  };
}
