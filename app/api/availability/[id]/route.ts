import { NextRequest } from 'next/server';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { noStore } from '@/lib/server/http';
import { availabilityStore } from '@/lib/server/availability-runner';
import { AvailabilityError } from '@/lib/server/availability-store';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getChatGPTUser();
  if (!user)
    return noStore({ error: 'Sign in to remove a target.' }, { status: 401 });
  if (
    request.headers.get('origin') &&
    request.headers.get('origin') !== new URL(request.url).origin
  )
    return noStore(
      { error: 'Cross-origin changes are not allowed.' },
      { status: 403 },
    );
  try {
    await availabilityStore().remove(
      user.userId,
      (await params).id,
      Date.now(),
    );
    return noStore({ removed: true });
  } catch (error) {
    return noStore(
      {
        error:
          error instanceof AvailabilityError
            ? error.message
            : 'Target could not be removed.',
      },
      { status: error instanceof AvailabilityError ? error.status : 503 },
    );
  }
}
