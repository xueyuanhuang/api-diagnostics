export function isInsecureHttp(value: string) {
  try {
    return new URL(value).protocol === 'http:';
  } catch {
    return false;
  }
}

export function confirmHttpRisk(
  urls: string[],
  confirm: (message: string) => boolean,
) {
  const origins = [
    ...new Set(
      urls.filter(isInsecureHttp).map((value) => new URL(value).origin),
    ),
  ];
  return (
    origins.length === 0 ||
    confirm(
      `Unencrypted HTTP connection: ${origins.join(', ')}\n\nWhen testing, your API key, prompts, and responses travel without encryption between this site's relay and the provider. People on that network path could read or modify them. Saved keys remain encrypted at rest, but that does not protect HTTP traffic.\n\nUse HTTPS or a temporary, low-limit key. Continue with HTTP?`,
    )
  );
}
