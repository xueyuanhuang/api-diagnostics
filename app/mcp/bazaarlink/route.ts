import { reviewMcp } from '@/lib/server/review-mcp';
export async function POST(request: Request) { return reviewMcp(request,'bazaarlink'); }
export const GET = POST;
export const DELETE = POST;
