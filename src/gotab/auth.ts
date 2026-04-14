import { GoTabCredentials, GoTabToken } from "./types";

// ---------------------------------------------------------------------------
// GoTab Authentication
// https://docs.gotab.io/reference/authtoken
// ---------------------------------------------------------------------------

const GOTAB_BASE_URL = "https://gotab.io";

// We subtract a small buffer before the real expiry so we never hand out a
// token that's valid now but expired by the time the downstream request
// reaches GoTab's servers (clock skew + network latency).
const EXPIRY_BUFFER_SECONDS = 60;

export class GoTabAuthError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "GoTabAuthError";
  }
}

/**
 * A minimal in-process token cache. One instance per set of credentials.
 *
 * Why cache server-side? The GoTab auth endpoint is not meant to be called
 * on every payment-session request. Caching the token until (expiry - buffer)
 * keeps us well within rate limits and shaves ~100ms off every session create.
 *
 * Why not Redis? For a single-process service, in-memory is fine and avoids
 * the operational overhead. For a horizontally-scaled deployment, swap the
 * private field for a shared cache layer — the interface stays the same.
 */
export class TokenCache {
  private cached: GoTabToken | null = null;

  isValid(): boolean {
    if (!this.cached) return false;
    const nowSeconds = Math.floor(Date.now() / 1000);
    return this.cached.expires - EXPIRY_BUFFER_SECONDS > nowSeconds;
  }

  get(): GoTabToken | null {
    return this.isValid() ? this.cached : null;
  }

  set(token: GoTabToken): void {
    this.cached = token;
  }

  clear(): void {
    this.cached = null;
  }
}

// A module-level cache shared across calls with the same credentials within a
// process lifetime. In practice each GoTab location/integration has its own
// credential pair, so a single cache is fine for the common case.
const defaultCache = new TokenCache();

/**
 * Fetches a fresh token from GoTab's OAuth endpoint.
 * Exposed separately so callers can also use it to force-refresh.
 */
export async function fetchToken(
  credentials: GoTabCredentials,
  baseUrl = GOTAB_BASE_URL,
  cache: TokenCache = defaultCache,
): Promise<GoTabToken> {
  const response = await fetch(`${baseUrl}/api/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_access_id: credentials.apiAccessId,
      api_access_secret: credentials.apiAccessSecret,
    }),
  });

  if (!response.ok) {
    throw new GoTabAuthError(
      `GoTab auth failed with status ${response.status}`,
      response.status,
    );
  }

  const token = (await response.json()) as GoTabToken;
  cache.set(token);
  return token;
}

/**
 * Returns a valid bearer token, using the cache when possible.
 *
 * This is the function all GoTab API callers should use — they don't need to
 * know about caching or token lifecycle at all.
 */
export async function getToken(
  credentials: GoTabCredentials,
  baseUrl = GOTAB_BASE_URL,
  cache: TokenCache = defaultCache,
): Promise<string> {
  const cached = cache.get();
  if (cached) return cached.token;

  const token = await fetchToken(credentials, baseUrl, cache);
  return token.token;
}
