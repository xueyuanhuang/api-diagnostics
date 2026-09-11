import { WorkspaceLink as Link } from '@/components/workspace-navigation';

export default function PrivacyPage() {
  return <main className="mx-auto max-w-3xl space-y-6 px-6 py-12">
    <Link href="/" className="underline">API Diagnostics</Link>
    <h1 className="text-3xl font-bold">Privacy</h1>
    <p>API Diagnostics uses your Google account identifier, verified email address and name to sign you in and associate your saved connections and test results with your account. Sign-in requests only basic profile information; it does not request your Gmail, Drive or other Google content.</p>
    <p>Saved connections, model lists and test records are stored on Cloudflare. Saved provider API keys are encrypted on the server. When you run a test, the service sends the test request and the required API key to the provider address you selected. Responses and diagnostic evidence may be saved with your account.</p>
    <p>If you import from the original ChatGPT-hosted website, the service copies the connections and results you authorize into your signed-in account. API keys are transferred between the servers and encrypted again for this website.</p>
    <p>Essential cookies keep you signed in and protect the login flow. Browser storage may retain interface preferences and earlier local results. Downloaded files remain on the device where you saved them.</p>
    <p>You can remove saved connections through the Connections page. For questions or requests to remove other account data, contact <a className="underline" href="mailto:xue_yuanhuang@163.com">xue_yuanhuang@163.com</a>.</p>
  </main>;
}
