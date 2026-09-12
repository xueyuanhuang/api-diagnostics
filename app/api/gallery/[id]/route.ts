import { env } from 'cloudflare:workers';
export async function GET(_request: Request, {params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  const row = await env.DB.prepare('SELECT object_key FROM public_gallery WHERE id = ?').bind(id).first<{object_key: string}>();
  if (!row) return new Response('Not found', {status: 404});
  const object = await env.EVIDENCE.get(row.object_key);
  if (!object) return new Response('Not found', {status: 404});
  return new Response(object.body, {headers: {'Content-Type':'text/plain; charset=utf-8','X-Content-Type-Options':'nosniff','Cache-Control':'no-store'}});
}
