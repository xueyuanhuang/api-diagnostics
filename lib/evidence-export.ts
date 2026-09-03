'use client';

type HeaderEntry = [string, string];

export type EvidenceRun = {
  id?: string | null;
  source: 'current' | 'saved';
  profileName?: string | null;
  apiType: string;
  baseUrl: string;
  modelName: string;
  verdict: string;
  normalCount: number;
  cacheCount: number;
  largeCount: number;
  unavailableCount: number;
  errorCount: number;
  medianTtftMs?: number | null;
  medianGenerationMs?: number | null;
  medianTotalTimeMs?: number | null;
  medianOutputTokensPerSecond?: number | null;
  createdAt: number;
};

export type EvidenceResult = {
  id: string;
  category: string;
  prompt: string;
  status: string;
  httpStatus?: number | null;
  returnedModel?: string | null;
  inputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  totalInputTokens?: number | null;
  outputTokens?: number | null;
  ttftMs?: number | null;
  generationMs?: number | null;
  totalTimeMs?: number | null;
  outputTokensPerSecond?: number | null;
  requestMethod?: string | null;
  requestUrl?: string | null;
  requestHeaders?: string | null;
  requestBody?: string | null;
  responseHeaders?: string | null;
  requestId?: string | null;
  answer?: string | null;
  rawResponse?: string | null;
  error?: string | null;
};

type ZipEntry = { name: string; bytes: Uint8Array };

const encoder = new TextEncoder();

function json(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function safeSegment(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'question'
  );
}

function parseHeaderEntries(
  value: string | null | undefined,
): HeaderEntry[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.every(
        (entry) =>
          Array.isArray(entry) &&
          entry.length === 2 &&
          typeof entry[0] === 'string' &&
          typeof entry[1] === 'string',
      )
    ) {
      return parsed as HeaderEntry[];
    }
  } catch {
    // Older or incomplete records are represented as unavailable in the archive.
  }
  return null;
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function shellHeader(name: string, value: string) {
  return `${name}: ${value}`
    .split('$API_KEY')
    .map((part) => (part ? shellQuote(part) : ''))
    .join('"$API_KEY"');
}

function curlScript(result: EvidenceResult, headers: HeaderEntry[] | null) {
  if (
    !result.requestMethod ||
    !result.requestUrl ||
    !result.requestBody ||
    !headers
  ) {
    return [
      '#!/usr/bin/env bash',
      '# Exact request evidence was not recorded for this older or incomplete result.',
      '# Run a new test to generate a reproducible cURL command.',
      '',
    ].join('\n');
  }

  const lines = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    ': "${API_KEY:?Set API_KEY before running this request}"',
    'cd "$(dirname "$0")"',
    '',
    `curl --no-buffer --request ${shellQuote(result.requestMethod)} ${shellQuote(result.requestUrl)} \\`,
  ];
  for (const [name, value] of headers) {
    lines.push(`  --header ${shellHeader(name, value)} \\`);
  }
  lines.push(
    '  --dump-header reproduced-response-headers.txt \\',
    '  --output reproduced-response-body.txt \\',
    '  --data-binary @request-body.json',
    '',
  );
  return lines.join('\n');
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTimestamp(date: Date) {
  const year = Math.max(1980, date.getFullYear());
  const time =
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    (date.getSeconds() >> 1);
  const day =
    ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function joinBytes(parts: Uint8Array[]) {
  const result = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function zip(entries: ZipEntry[], date: Date) {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  const { time, day } = dosTimestamp(date);
  let localOffset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const checksum = crc32(entry.bytes);
    const local = new Uint8Array(30);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, time, true);
    localView.setUint16(12, day, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, entry.bytes.length, true);
    localView.setUint32(22, entry.bytes.length, true);
    localView.setUint16(26, name.length, true);
    localParts.push(local, name, entry.bytes);

    const central = new Uint8Array(46);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, time, true);
    centralView.setUint16(14, day, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, entry.bytes.length, true);
    centralView.setUint32(24, entry.bytes.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, localOffset, true);
    centralParts.push(central, name);
    localOffset += local.length + name.length + entry.bytes.length;
  }

  const centralDirectory = joinBytes(centralParts);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralDirectory.length, true);
  endView.setUint32(16, localOffset, true);
  return joinBytes([...localParts, centralDirectory, end]);
}

function addText(entries: ZipEntry[], name: string, text: string) {
  entries.push({ name, bytes: encoder.encode(text) });
}

export function buildEvidenceArchive(
  run: EvidenceRun,
  results: EvidenceResult[],
) {
  const exportedAt = new Date();
  const entries: ZipEntry[] = [];
  const manifest = {
    exportFormat: 'normal-token-check-evidence-v1',
    exportedAt: exportedAt.toISOString(),
    run,
    captureNotes: {
      requestHeaders:
        'Headers explicitly set by the tester relay. Platform-added transport headers are not observable.',
      responseHeaders:
        'Headers exposed to the tester relay by server-side fetch. Cookie values and any API-key echo are redacted.',
      responseBody:
        'Complete upstream response body captured by the tester within its 1 MB safety limit.',
      timing:
        'Measured from the tester relay. DNS, TCP, and TLS phase timings are not included.',
      apiKey:
        'Never stored or exported. Reproducible cURL files use the $API_KEY environment variable.',
    },
    questionCount: results.length,
  };
  addText(
    entries,
    'README.txt',
    [
      'Normal Token Check evidence export',
      '',
      'Each question folder contains the exact JSON request body recorded by the tester,',
      'the application headers it explicitly set, a reproducible cURL command, the response',
      'headers visible to server-side fetch, the captured raw response body, and normalized results.',
      '',
      'Security: API keys and cookie values are not included. Set API_KEY in your shell before',
      'running a request.curl.sh file. A direct cURL retry uses your current network and is not',
      'expected to reproduce the original latency.',
      '',
    ].join('\n'),
  );
  addText(entries, 'manifest.json', json(manifest));

  results.forEach((result, index) => {
    const folder = `questions/${String(index + 1).padStart(2, '0')}-${safeSegment(result.category)}`;
    const requestHeaders = parseHeaderEntries(result.requestHeaders);
    const responseHeaders = parseHeaderEntries(result.responseHeaders);
    addText(
      entries,
      `${folder}/request.curl.sh`,
      curlScript(result, requestHeaders),
    );
    addText(
      entries,
      `${folder}/request-headers.json`,
      requestHeaders ? json(requestHeaders) : json({ unavailable: true }),
    );
    addText(
      entries,
      `${folder}/request-body.json`,
      result.requestBody ?? json({ unavailable: true }),
    );
    addText(
      entries,
      `${folder}/response-headers.json`,
      responseHeaders ? json(responseHeaders) : json({ unavailable: true }),
    );
    addText(
      entries,
      `${folder}/response-headers.txt`,
      responseHeaders
        ? `${responseHeaders.map(([name, value]) => `${name}: ${value}`).join('\n')}\n`
        : 'UNAVAILABLE: response headers were not recorded for this result.\n',
    );
    addText(
      entries,
      `${folder}/response-body.txt`,
      result.rawResponse ??
        'UNAVAILABLE: response body was not recorded for this result.\n',
    );
    addText(
      entries,
      `${folder}/normalized-result.json`,
      json({
        questionId: result.id,
        category: result.category,
        prompt: result.prompt,
        status: result.status,
        httpStatus: result.httpStatus ?? null,
        returnedModel: result.returnedModel ?? null,
        requestId: result.requestId ?? null,
        tokens: {
          input: result.inputTokens ?? null,
          cacheCreationInput: result.cacheCreationInputTokens ?? null,
          cacheReadInput: result.cacheReadInputTokens ?? null,
          totalInput: result.totalInputTokens ?? null,
          output: result.outputTokens ?? null,
        },
        performance: {
          ttftMs: result.ttftMs ?? null,
          generationMs: result.generationMs ?? null,
          totalTimeMs: result.totalTimeMs ?? null,
          outputTokensPerSecond: result.outputTokensPerSecond ?? null,
        },
        answer: result.answer ?? null,
        error: result.error ?? null,
      }),
    );
  });

  const bytes = zip(entries, exportedAt);
  const timestamp = new Date(run.createdAt).toISOString().replace(/[:.]/g, '-');
  return {
    bytes,
    fileName: `normal-token-check-evidence-${timestamp}.zip`,
  };
}

export function downloadEvidenceArchive(
  run: EvidenceRun,
  results: EvidenceResult[],
) {
  const { bytes, fileName } = buildEvidenceArchive(run, results);
  const data = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const objectUrl = URL.createObjectURL(
    new Blob([data], { type: 'application/zip' }),
  );
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}
