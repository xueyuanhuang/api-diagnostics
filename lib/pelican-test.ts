export const PELICAN_PROMPT = '创建一个HTML，内容是SVG绘制的一个鹈鹕骑自行车的2D动画，你不需要任何测试';
export const PELICAN_OUTPUT_CEILING = 2147483647;
export const PELICAN_MAX_TOKENS = 32768;

export function pelicanOutputLimit(value: unknown) {
  if (value === undefined) return PELICAN_MAX_TOKENS;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= PELICAN_OUTPUT_CEILING ? value : null;
}
export function adjustPelicanOutputLimit(limit: number, percentage: number) {
  return Math.min(PELICAN_OUTPUT_CEILING, Math.max(1, Math.round(limit * (1 + percentage / 100))));
}
export const PELICAN_TIMEOUT_MS = 300_000;

export function extractAnimationHtml(answer: string) {
  const fenced = answer.match(/```(?:html)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? answer;
  const start = candidate.search(/<!doctype\s+html|<html[\s>]|<svg[\s>]/i);
  if (start < 0) return '';
  return candidate.slice(start).replace(/```\s*$/, '').trim();
}

export function animationPreviewDocument(html: string, autoFit = false) {
  // The opaque-origin sandbox separates generated scripts from credentials.
  // Put the restrictive policy first so model output cannot loosen it.
  const sizing = autoFit ? `<script>
(() => {
  let pending = false;
  let last = 0;
  const measure = () => {
    pending = false;
    if (!document.body) return;
    let height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    for (const svg of document.querySelectorAll('svg[viewBox]')) {
      if (svg.parentElement?.closest('svg')) continue;
      const box = svg.getBoundingClientRect();
      const view = svg.viewBox.baseVal;
      if (box.width < 200 || view.width <= 0 || view.height <= 0) continue;
      const naturalHeight = Math.ceil(box.width * view.height / view.width);
      if (svg.style.getPropertyValue('height') !== naturalHeight + 'px') svg.style.setProperty('height', naturalHeight + 'px', 'important');
      svg.style.setProperty('max-height', 'none', 'important');
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      for (let parent = svg.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        if (parent.scrollHeight > parent.clientHeight + 2 && getComputedStyle(parent).overflowY === 'hidden') {
          parent.style.setProperty('overflow', 'visible', 'important');
          parent.style.setProperty('height', 'auto', 'important');
          parent.style.setProperty('max-height', 'none', 'important');
        }
      }
      const fitted = svg.getBoundingClientRect();
      height = Math.max(height, Math.max(0, fitted.top) + naturalHeight, document.body.scrollHeight);
    }
    height = Math.min(24000, Math.ceil(height));
    if (Math.abs(height - last) > 2) { last = height; parent.postMessage({type:'pelican-preview-size', height}, '*'); }
  };
  const schedule = () => { if (!pending) { pending = true; requestAnimationFrame(measure); } };
  const start = () => {
    const style = document.createElement('style');
    style.textContent = 'html{overflow:hidden!important}';
    document.head.appendChild(style);
    new ResizeObserver(schedule).observe(document.body);
    window.addEventListener('resize', () => { last = 0; schedule(); });
    schedule();
    setTimeout(schedule, 300);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once:true}); else start();
})();
</script>` : '';
  return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">${html}${sizing}`;
}

export function animationWarning(html: string, result: { finishReason?: string | null; maxOutputTokens?: number | null; outputTokens?: number | null }) {
  const missingEnd = (/<html[\s>]/i.test(html) && !/<\/html\s*>/i.test(html)) || (/<svg[\s>]/i.test(html) && !/<\/svg\s*>/i.test(html));
  const limit = result.maxOutputTokens ?? 8192; // Saved results before selectable limits.
  const hitLimit = ['max_tokens', 'length'].includes(result.finishReason ?? '') || (!result.finishReason && result.outputTokens != null && result.outputTokens >= limit);
  if (hitLimit) return `The provider reached the ${limit.toLocaleString('en-US')}-token output limit.${missingEnd ? ' The HTML/SVG is unfinished, so the preview may be blank or partial.' : ' The response may be incomplete.'} Choose a higher output limit and run again. This saved response is unchanged.`;
  if (missingEnd) return 'The returned HTML/SVG appears unfinished, so the preview may be blank or partial. The full response received is saved below.';
  return null;
}
