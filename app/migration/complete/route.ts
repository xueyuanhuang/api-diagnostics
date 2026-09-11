import { GET } from '../../auth/chatgpt/callback/route';
export { GET };

export async function POST(request:Request) {
  if(request.headers.get('origin')!==new URL(request.url).origin)return new Response('Invalid origin.',{status:403});
  try {
    const body=await request.json() as {url?:string};
    if(typeof body.url!=='string'||body.url.length>2048)return new Response('Invalid transfer link.',{status:400});
    const url=new URL(body.url);
    if(url.origin!==new URL(request.url).origin||!['/migration/complete','/auth/chatgpt/callback'].includes(url.pathname))return new Response('Invalid transfer destination.',{status:400});
    const result=await GET(new Request(url,{headers:request.headers}));
    if(result.status!==303)return result;
    return Response.json({imported:true},{headers:{'Cache-Control':'no-store','Set-Cookie':result.headers.get('set-cookie')??''}});
  }catch{return new Response('Transfer could not finish.',{status:400});}
}
