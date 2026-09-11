export const PELICAN_PROMPT = '创建一个HTML，内容是SVG绘制的一个鹈鹕骑自行车的2D动画，你不需要任何测试';
export const PELICAN_OUTPUT_LIMITS = [8192, 16384, 32768] as const;
export const PELICAN_MAX_TOKENS = 32768;

export function pelicanOutputLimit(value: unknown) {
  if (value === undefined) return PELICAN_MAX_TOKENS;
  return typeof value === 'number' && PELICAN_OUTPUT_LIMITS.some(limit => limit === value) ? value : null;
}
export const PELICAN_TIMEOUT_MS = 300_000;

export function extractAnimationHtml(answer: string) {
  const fenced = answer.match(/```(?:html)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? answer;
  const start = candidate.search(/<!doctype\s+html|<html[\s>]|<svg[\s>]/i);
  if (start < 0) return '';
  return candidate.slice(start).replace(/```\s*$/, '').trim();
}

export function animationPreviewDocument(html: string) {
  // The opaque-origin sandbox separates generated scripts from credentials.
  // Put the restrictive policy first so model output cannot loosen it.
  return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">${html}`;
}

export function animationWarning(html: string, result: { finishReason?: string | null; maxOutputTokens?: number | null; outputTokens?: number | null }) {
  const missingEnd = (/<html[\s>]/i.test(html) && !/<\/html\s*>/i.test(html)) || (/<svg[\s>]/i.test(html) && !/<\/svg\s*>/i.test(html));
  const limit = result.maxOutputTokens ?? 8192; // Saved results before selectable limits.
  const hitLimit = ['max_tokens', 'length'].includes(result.finishReason ?? '') || (!result.finishReason && result.outputTokens != null && result.outputTokens >= limit);
  if (hitLimit) return `The provider reached the ${limit.toLocaleString('en-US')}-token output limit.${missingEnd ? ' The HTML/SVG is unfinished, so the preview may be blank or partial.' : ' The response may be incomplete.'} Choose a higher output limit and run again. This saved response is unchanged.`;
  if (missingEnd) return 'The returned HTML/SVG appears unfinished, so the preview may be blank or partial. The full response received is saved below.';
  return null;
}
