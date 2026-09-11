export const PELICAN_PROMPT = '创建一个HTML，内容是SVG绘制的一个鹈鹕骑自行车的2D动画，你不需要任何测试';
export const PELICAN_MAX_TOKENS = 8192;
export const PELICAN_TIMEOUT_MS = 180_000;

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
