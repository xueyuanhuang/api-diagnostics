import { getChatGPTUser } from '@/app/chatgpt-auth';
import { noStore } from '@/lib/server/http';
import { diagnostics, diagnosticError } from '@/lib/server/diagnostic-http';
import { diagnosticExport } from '@/lib/diagnostic-runs';

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const user = await getChatGPTUser();
  if (!user)
    return noStore({ error: 'Sign in to export this run.' }, { status: 401 });
  try {
    const { document } = await diagnostics().get(
      user.userId,
      (await context.params).id,
    );
    return noStore(diagnosticExport(document), {
      headers: {
        'Content-Disposition': `attachment; filename="${document.testKind}-${document.id}.json"`,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    return diagnosticError(error);
  }
}
