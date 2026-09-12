import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { noStore, serverError } from '@/lib/server/http';
import { canManageGallery, publicGallery, removePublicGalleryExample } from '@/lib/server/gallery';
import { listAnimations, readAnimation } from '@/lib/server/animation-store';
import { extractAnimationHtml } from '@/lib/pelican-test';
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!canManageGallery(user, env.GALLERY_OWNER_EMAIL_SHA256)) return noStore({canManage: false});
  try { return noStore({canManage:true, results: await listAnimations(env, user!.userId, new URL(request.url).searchParams.get('before'))}); }
  catch(error) { return serverError(error); }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!canManageGallery(user, env.GALLERY_OWNER_EMAIL_SHA256)) return noStore({error:'Only the site owner can change the public gallery.'}, {status:403});
  let body;
  try { const text = await request.text(); if(text.length > 2000) throw new Error(); body = JSON.parse(text); }
  catch { return noStore({error:'Invalid request.'}, {status:400}); }
  if(!body || typeof body !== 'object' || typeof body.animationId !== 'string' || typeof body.description !== 'string' || body.description.length > 200 || (body.replaceId && typeof body.replaceId !== 'string')) return noStore({error:'Choose a saved result and a description of up to 200 characters.'}, {status:400});
  try {
    const examples = await publicGallery(env.DB);
    if(body.replaceId && !examples.some(item => item.id === body.replaceId)) return noStore({error:'That gallery example no longer exists.'}, {status:404});
    const saved = await readAnimation(env, user!.userId, body.animationId);
    if(!saved) return noStore({error:'Saved result not found in your account.'}, {status:404});
    const html = extractAnimationHtml(saved.result.answer ?? '');
    if(!html) return noStore({error:'This result does not contain an animation.'}, {status:400});
    const id = body.replaceId || crypto.randomUUID();
    const objectKey = `public-gallery/${crypto.randomUUID()}.txt`;
    await env.EVIDENCE.put(objectKey, html, {httpMetadata: {contentType:'text/plain; charset=utf-8'}});
    await env.DB.prepare('INSERT INTO public_gallery (id, name, description, seconds, tokens, object_key, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, seconds=excluded.seconds, tokens=excluded.tokens, object_key=excluded.object_key, updated_at=excluded.updated_at').bind(id, saved.model, body.description.trim() || 'A saved take on the cycling challenge.', saved.result.totalTimeMs == null ? '—' : (saved.result.totalTimeMs / 1000).toFixed(1), saved.result.outputTokens == null ? '—' : saved.result.outputTokens.toLocaleString('en-US'), objectKey, Date.now()).run();
    return noStore({examples: await publicGallery(env.DB)});
  } catch(error) { return serverError(error); }
}

export async function DELETE(request: Request) {
  const user = await getChatGPTUser();
  if (!canManageGallery(user, env.GALLERY_OWNER_EMAIL_SHA256)) return noStore({error:'Only the site owner can change the public gallery.'}, {status:403});
  let body;
  try {
    const text = await request.text();
    if (text.length > 2000) throw new Error();
    body = JSON.parse(text);
  } catch { return noStore({error:'Invalid request.'}, {status:400}); }
  if (!body || typeof body !== 'object' || typeof body.id !== 'string' || !body.id.trim() || body.id.length > 160) return noStore({error:'Choose a gallery example to delete.'}, {status:400});
  try {
    if (!await removePublicGalleryExample(env.DB, body.id)) return noStore({error:'That gallery example no longer exists.'}, {status:404});
    return noStore({examples: await publicGallery(env.DB)});
  } catch(error) { return serverError(error); }
}
