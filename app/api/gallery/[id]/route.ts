import { env } from 'cloudflare:workers';
import { publicGalleryObjectKey } from '@/lib/server/gallery';
export async function GET(_request: Request, {params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  const objectKey = await publicGalleryObjectKey(env.DB, id);
  if (!objectKey) return new Response('Not found', {status: 404});
  const object = await env.EVIDENCE.get(objectKey);
  if (!object) return new Response('Not found', {status: 404});
  return new Response(object.body, {headers: {'Content-Type':'text/plain; charset=utf-8','X-Content-Type-Options':'nosniff','Cache-Control':'no-store'}});
}
