import { env } from 'cloudflare:workers';
import { noStore, serverError } from '@/lib/server/http';
import { publicGallery } from '@/lib/server/gallery';
export async function GET() {
  try { return noStore({ examples: await publicGallery(env.DB) }); }
  catch (error) { return serverError(error); }
}
