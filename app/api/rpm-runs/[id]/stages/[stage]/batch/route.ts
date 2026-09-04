import { noStore } from '@/lib/server/http';

export async function POST() {
  return noStore(
    {
      error:
        'Browser-timed batch dispatch has been retired. Start a new run with the server-timed dispatcher.',
    },
    { status: 410 },
  );
}
