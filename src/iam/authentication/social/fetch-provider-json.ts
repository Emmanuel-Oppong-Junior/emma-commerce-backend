import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';

export const PROVIDER_TIMEOUT_MS = 5000;

/**
 * Calls a social-login provider endpoint with a timeout.
 * A 4xx answer means the client's token was refused (401 with `rejection`); no answer, a 5xx or a body
 * that is not JSON means the provider is unavailable (503).
 */
export async function fetchProviderJson<T>(
  provider: string,
  url: URL,
  rejection: string,
  headers?: Record<string, string>,
): Promise<T> {
  const unavailable = () => new ServiceUnavailableException(`${provider} sign-in is unavailable, try again later`);
  let response: Response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
  } catch {
    // No cause attached: the request URL can carry the app secret.
    throw unavailable();
  }
  if (response.status >= 500) throw unavailable();
  if (!response.ok) throw new UnauthorizedException(rejection);
  try {
    return (await response.json()) as T;
  } catch {
    throw unavailable();
  }
}
