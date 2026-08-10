// SSRF guard for operator-supplied provider base URLs: without it, a `baseUrl` from the dashboard could point an adapter at the Worker's own network or a cloud metadata endpoint.
// Lives in one module because a per-adapter copy-paste version had already failed once (Anthropic fetched `config.baseUrl` unchecked); every adapter must call `assertPublicBaseUrl`.
import { ProviderRequestError } from './types';

const PRIVATE_HOST_PATTERNS = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^localhost$/i,
  // IPv6: URL.hostname returns the literal WITH brackets ("[::1]"), so `isPrivateHost` strips them before testing.
  /^::1?$/,                    // loopback and unspecified
  /^f[cd][0-9a-f]{2}:/i,       // fc00::/7  unique-local
  /^fe[89ab][0-9a-f]:/i,       // fe80::/10 link-local
  /^::ffff:/i,                 // IPv4-mapped, e.g. ::ffff:127.0.0.1
];

// Cloud instance-metadata endpoints, which are public-looking but reachable only from inside.
const METADATA_HOSTS = new Set(['metadata.google.internal', '100.100.100.200']);

export function isPrivateHost(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, '');
  return PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(host));
}

export function isValidPublicUrl(urlString: string) {
  try {
    const url = new URL(urlString);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (METADATA_HOSTS.has(url.hostname.toLowerCase())) return false;
    return !isPrivateHost(url.hostname);
  } catch {
    return false;
  }
}

// Throws the provider-shaped 400 every adapter already raises, so call sites stay one line.
export function assertPublicBaseUrl(baseUrl: string | null | undefined, providerName: string) {
  if (baseUrl && !isValidPublicUrl(baseUrl)) {
    throw new ProviderRequestError(providerName, 400, 'Invalid provider base URL.');
  }
}
