import { getChatGPTUser } from '@/app/chatgpt-auth';
import { noStore } from '@/lib/server/http';
import {
  diagnostics,
  diagnosticError,
  readDiagnosticPayload,
  validateDiagnosticMutation,
} from '@/lib/server/diagnostic-http';
import { validateDiagnosticRun } from '@/lib/server/diagnostic-store';

export async function GET() {
  const user = await getChatGPTUser();
  if (!user)
    return noStore({ error: 'Sign in to view saved runs.' }, { status: 401 });
  try {
    return noStore({ runs: await diagnostics().list(user.userId) });
  } catch (error) {
    return diagnosticError(error);
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return noStore({ error: 'Sign in to save this run.' }, { status: 401 });
  try {
    validateDiagnosticMutation(request, true);
    const payload = await readDiagnosticPayload(request);
    const document = validateDiagnosticRun(payload?.document);
    return noStore({
      run: await diagnostics().save(
        user.userId,
        document,
        payload.revision as number,
      ),
    });
  } catch (error) {
    return diagnosticError(error);
  }
}
