import { headers } from 'next/headers';

export { chatGPTSignInPath, chatGPTSignOutPath } from '@/lib/auth-paths';

export type ChatGPTUser = {
  userId: string;
  displayName: string;
  email: string;
  fullName: string | null;
};

export async function getChatGPTUser(): Promise<ChatGPTUser | null> {
  const requestHeaders = await headers();
  const userId = requestHeaders.get('oai-authenticated-user-id');
  const email = requestHeaders.get('oai-authenticated-user-email');
  if (!userId || !email) return null;

  const encodedFullName = requestHeaders.get('oai-authenticated-user-full-name');
  const fullName =
    encodedFullName &&
    requestHeaders.get('oai-authenticated-user-full-name-encoding') === 'percent-encoded-utf-8'
      ? safeDecodeURIComponent(encodedFullName)
      : null;

  return { userId, email, fullName, displayName: fullName ?? email };
}

function safeDecodeURIComponent(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
