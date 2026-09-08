import { getChatGPTUser } from '@/app/chatgpt-auth';
import { noStore } from '@/lib/server/http';
import {
  diagnostics,
  diagnosticError,
  validateDiagnosticMutation,
} from '@/lib/server/diagnostic-http';

type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, context: Context) {
  const user = await getChatGPTUser();
  if (!user)
    return noStore({ error: 'Sign in to view this run.' }, { status: 401 });
  try {
    return noStore(
      await diagnostics().get(user.userId, (await context.params).id),
    );
  } catch (error) {
    return diagnosticError(error);
  }
}
export async function DELETE(request: Request, context: Context) {
  const user = await getChatGPTUser();
  if (!user)
    return noStore({ error: 'Sign in to delete this run.' }, { status: 401 });
  try {
    validateDiagnosticMutation(request);
    await diagnostics().delete(user.userId, (await context.params).id);
    return noStore({ deleted: true });
  } catch (error) {
    return diagnosticError(error);
  }
}
