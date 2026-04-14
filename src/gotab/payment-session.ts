import {
  GoTabCredentials,
  GoTabApiError,
  GoTabResponse,
  PaymentSession,
} from "./types";
import { TokenCache, getToken } from "./auth";

// ---------------------------------------------------------------------------
// GoTab Payment Session Service
// https://docs.gotab.io/reference/createpaymentsession
// ---------------------------------------------------------------------------

// Why is this the most critical piece?
//
// The payment session is a time-bounded capability token that the frontend
// must have before GoTab's wallet SDK can initialize. Every payment attempt
// flows through here — no session, no payment. It's also the natural place
// to enforce tab ownership (only the user whose order maps to this tabUuid
// should be able to get a session for it). Auth management lives here too,
// making it the highest-leverage backend component to get right.

const GOTAB_BASE_URL = "https://gotab.io";

// How early before the GoTab-reported expiry we consider a session "expired"
// on our side. Gives the client enough time to actually use the session after
// receiving it from us.
const SESSION_EXPIRY_BUFFER_MS = 30_000;

export class GoTabPaymentError extends Error {
  constructor(
    message: string,
    public readonly errors: GoTabApiError[],
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "GoTabPaymentError";
  }
}

export interface PaymentSessionServiceConfig {
  credentials: GoTabCredentials;
  locationUuid: string;
  /** Override for testing or staging environments */
  baseUrl?: string;
  /** Override for testing — injects a custom token cache */
  tokenCache?: TokenCache;
}

/**
 * Fetches a GoTab payment session for a given tab. The session ID is returned
 * to the frontend, which passes it directly to `initWallet()` in the SDK.
 *
 * Callers are responsible for ensuring the tabUuid belongs to the requesting
 * user before calling this method — this service doesn't know about Tapin's
 * user model.
 */
export class GoTabPaymentSessionService {
  private readonly credentials: GoTabCredentials;
  private readonly locationUuid: string;
  private readonly baseUrl: string;
  private readonly tokenCache: TokenCache;

  constructor(config: PaymentSessionServiceConfig) {
    this.credentials = config.credentials;
    this.locationUuid = config.locationUuid;
    this.baseUrl = config.baseUrl ?? GOTAB_BASE_URL;
    // Allow callers to inject a cache instance so tests can inspect it
    this.tokenCache = config.tokenCache ?? new TokenCache();
  }

  /**
   * Creates a new payment session for the given GoTab tab.
   *
   * Throws `GoTabPaymentError` if GoTab returns errors (e.g. tab not found,
   * tab already closed). Throws `GoTabAuthError` if authentication fails.
   */
  async createSession(tabUuid: string): Promise<PaymentSession> {
    const token = await getToken(
      this.credentials,
      this.baseUrl,
      this.tokenCache,
    );

    const url = `${this.baseUrl}/api/v2/loc/${this.locationUuid}/payment-sessions/${tabUuid}`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    // Parse the body regardless of status — GoTab puts error detail in the
    // body even on 4xx responses, and we want to surface those to callers.
    const body = (await response.json()) as GoTabResponse<PaymentSession>;

    if (!response.ok || body.errors?.length > 0) {
      const errors = body.errors ?? [];
      throw new GoTabPaymentError(
        errors[0]?.message ?? `GoTab payment session request failed (${response.status})`,
        errors,
        response.status,
      );
    }

    return body.data;
  }

  /**
   * Returns true if the session is still usable with enough time remaining
   * for the client to act on it.
   *
   * We apply a 30-second buffer: a session that expires in 10 seconds is
   * technically valid but the client almost certainly can't complete wallet
   * initialization before it lapses.
   */
  isSessionValid(session: PaymentSession): boolean {
    const expiresAt = new Date(session.expires).getTime();
    return expiresAt - SESSION_EXPIRY_BUFFER_MS > Date.now();
  }
}
