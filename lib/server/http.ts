import { NextResponse } from 'next/server';

export function noStore<T>(body: T, init?: ResponseInit) {
  const response = NextResponse.json(body, init);
  response.headers.set('Cache-Control', 'no-store, max-age=0');
  response.headers.set('Pragma', 'no-cache');
  return response;
}

export function serverError(error: unknown) {
  console.error(error);
  return noStore({ error: 'Something went wrong. Please try again.' }, { status: 500 });
}
