import { oauth } from '@/lib/server/mcp-oauth';
type Context = { params: Promise<{action: string}> };
export async function GET(request: Request, context: Context) { return oauth(request, (await context.params).action); }
export const POST = GET;
