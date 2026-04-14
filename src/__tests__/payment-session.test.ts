import { GoTabPaymentSessionService, GoTabPaymentError } from "../gotab/payment-session";
import { TokenCache } from "../gotab/auth";
import { GoTabCredentials, PaymentSession } from "../gotab/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const credentials: GoTabCredentials = {
  apiAccessId: "test-id",
  apiAccessSecret: "test-secret",
};

const locationUuid = "loc-123";
const tabUuid = "tab-abc";

/** Returns a session that expires 10 minutes from now */
function futureSession(offsetMs = 10 * 60 * 1000): PaymentSession {
  return {
    paymentSessionId: "sess-xyz",
    expires: new Date(Date.now() + offsetMs).toISOString(),
  };
}

/**
 * Creates a GoTabPaymentSessionService wired to a mock fetch and a fresh
 * TokenCache that is pre-populated with a valid token so auth calls don't need
 * to be mocked separately in every test.
 */
function makeService(mockFetch: jest.Mock) {
  const cache = new TokenCache();
  // Pre-load the cache with a token that won't expire during the test
  cache.set({
    token: "mock-jwt",
    refreshToken: "mock-refresh",
    tokenType: "Bearer",
    initiated: Math.floor(Date.now() / 1000),
    expires: Math.floor(Date.now() / 1000) + 3600,
    expiresIn: 3600,
  });

  const service = new GoTabPaymentSessionService({
    credentials,
    locationUuid,
    baseUrl: "https://mock.gotab.io",
    tokenCache: cache,
  });

  // Replace the global fetch used by the service
  global.fetch = mockFetch;

  return { service, cache };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GoTabPaymentSessionService.createSession", () => {
  it("returns a PaymentSession on a successful 200 response", async () => {
    const session = futureSession();
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: session, warnings: [], errors: [] }),
    });

    const { service } = makeService(mockFetch);
    const result = await service.createSession(tabUuid);

    expect(result.paymentSessionId).toBe("sess-xyz");
    expect(result.expires).toBe(session.expires);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      `https://mock.gotab.io/api/v2/loc/${locationUuid}/payment-sessions/${tabUuid}`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer mock-jwt",
        }),
      }),
    );
  });

  it("throws GoTabPaymentError when the response body contains errors", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({
        data: null,
        warnings: [],
        errors: [{ type: "TAB_NOT_FOUND", message: "Tab not found" }],
      }),
    });

    const { service } = makeService(mockFetch);

    await expect(service.createSession(tabUuid)).rejects.toThrow(GoTabPaymentError);
    await expect(service.createSession(tabUuid)).rejects.toMatchObject({
      message: "Tab not found",
      errors: [{ type: "TAB_NOT_FOUND" }],
      statusCode: 404,
    });
  });

  it("throws GoTabPaymentError with a fallback message when errors array is empty", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ data: null, warnings: [], errors: [] }),
    });

    const { service } = makeService(mockFetch);

    await expect(service.createSession(tabUuid)).rejects.toThrow(
      /GoTab payment session request failed \(500\)/,
    );
  });

  it("only calls the auth endpoint once across two createSession calls (token cached)", async () => {
    const session = futureSession();

    // Auth fetch + two session fetches
    const authFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        token: "new-jwt",
        refreshToken: "new-refresh",
        tokenType: "Bearer",
        initiated: Math.floor(Date.now() / 1000),
        expires: Math.floor(Date.now() / 1000) + 3600,
        expiresIn: 3600,
      }),
    });
    const sessionFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: session, warnings: [], errors: [] }),
    });

    // Use a fresh empty cache so we can observe the auth call
    const cache = new TokenCache();
    const service = new GoTabPaymentSessionService({
      credentials,
      locationUuid,
      baseUrl: "https://mock.gotab.io",
      tokenCache: cache,
    });

    let callCount = 0;
    global.fetch = jest.fn().mockImplementation((url: string) => {
      callCount++;
      if ((url as string).includes("/api/oauth/token")) return authFetch(url);
      return sessionFetch(url);
    });

    await service.createSession(tabUuid);
    await service.createSession(tabUuid);

    // Auth should only be called once; session endpoint twice
    expect(authFetch).toHaveBeenCalledTimes(1);
    expect(sessionFetch).toHaveBeenCalledTimes(2);
  });
});

describe("GoTabPaymentSessionService.isSessionValid", () => {
  const service = new GoTabPaymentSessionService({
    credentials,
    locationUuid,
  });

  it("returns true for a session expiring well in the future", () => {
    expect(service.isSessionValid(futureSession(10 * 60 * 1000))).toBe(true);
  });

  it("returns false for an already-expired session", () => {
    const expired: PaymentSession = {
      paymentSessionId: "sess-old",
      expires: new Date(Date.now() - 1000).toISOString(),
    };
    expect(service.isSessionValid(expired)).toBe(false);
  });

  it("returns false for a session inside the 30-second buffer window", () => {
    // 20 seconds remaining — valid per GoTab, but not safe to hand to a client
    const almostExpired: PaymentSession = {
      paymentSessionId: "sess-edge",
      expires: new Date(Date.now() + 20_000).toISOString(),
    };
    expect(service.isSessionValid(almostExpired)).toBe(false);
  });

  it("returns true for a session just outside the buffer (31 seconds remaining)", () => {
    const justValid: PaymentSession = {
      paymentSessionId: "sess-fine",
      expires: new Date(Date.now() + 31_000).toISOString(),
    };
    expect(service.isSessionValid(justValid)).toBe(true);
  });
});
