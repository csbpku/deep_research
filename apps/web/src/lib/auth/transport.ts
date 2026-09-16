/**
 * Authentication transport checks.
 *
 * The public reverse proxy is the trust boundary for x-forwarded-proto. The
 * web container is only bound to loopback in production, and nginx overwrites
 * this header with its own scheme before proxying the request.
 */

function forwardedProtocol(headers: Headers): string | null {
  const value = headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  return value === 'http' || value === 'https' ? value : null;
}

export function effectiveRequestProtocol(headers: Headers, requestUrl?: string): string | null {
  const forwarded = forwardedProtocol(headers);
  if (forwarded) return forwarded;

  if (!requestUrl) return null;
  try {
    const protocol = new URL(requestUrl).protocol.replace(':', '').toLowerCase();
    return protocol === 'http' || protocol === 'https' ? protocol : null;
  } catch {
    return null;
  }
}

export function isSecureRequest(request: Request): boolean {
  return effectiveRequestProtocol(request.headers, request.url) === 'https';
}

export function isProductionAuthAllowed(
  headers: Headers,
  nodeEnv: string | undefined = process.env.NODE_ENV,
  requestUrl?: string,
  allowInsecureHttp = false,
): boolean {
  return (
    nodeEnv !== 'production' ||
    allowInsecureHttp ||
    effectiveRequestProtocol(headers, requestUrl) === 'https'
  );
}
