import { TokenCheckApp } from '@/components/token-check-app';
import { chatGPTSignInPath, chatGPTSignOutPath } from '@/lib/auth-paths';

export default function Home() {
  return (
    <TokenCheckApp
      signInPath={chatGPTSignInPath('/')}
      signOutPath={chatGPTSignOutPath('/')}
    />
  );
}
