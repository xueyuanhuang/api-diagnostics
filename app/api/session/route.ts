import { getChatGPTUser } from '@/app/chatgpt-auth';
import { noStore } from '@/lib/server/http';

export async function GET() {
  const user = await getChatGPTUser();
  return noStore({
    user: user ? { displayName: user.displayName, email: user.email } : null,
  });
}
