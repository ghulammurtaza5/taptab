# GoTab Payment Integration — System Design

## What I'd Build

### The Payment Flow End-to-End

```
User taps "Pay" in Tapin app
        │
        ▼
Tapin API  POST /payments/session  { orderId }
        │
        ├─► Verify tab ownership (orderId → tabUuid belongs to this user)
        │
        ├─► getToken()  →  TokenCache  →  POST /api/oauth/token  (only on miss/expiry)
        │
        └─► POST /api/v2/loc/{locationUuid}/payment-sessions/{tabUuid}
                │
                ▼
        { paymentSessionId, expires }  returned to client
                │
                ▼
        Client calls GoTab SDK:  initWallet({ paymentSessionId, tabUuid, ... })
                │
                ▼
        GoTab handles card tokenization (VGS), charge, confirmation
                │
                ▼
        GoTab fires webhooks to Tapin  ──►  CLOSE_TAB / ORDER_PLACED
                │
                ▼
        Tapin reconciles order state, notifies client
```

### Pieces I'd Build

**1. Auth Service (`auth.ts`)**
A singleton token cache per credential pair. Tokens are fetched from `POST /api/oauth/token` using the server-side `api_access_id`/`api_access_secret` and cached until 60 seconds before expiry. This is the only place credentials appear in the codebase; everything else calls `getToken()`.

**2. Payment Session Service (`payment-session.ts`)**
The server-side gatekeeper. Creates a payment session for a given tab, enforces tab-ownership authorization before calling GoTab, and returns the session ID to the client. Also exposes `isSessionValid()` so callers can gate on the 30-second buffer before handing a session to a frontend that might be slow to initialize the wallet.

**3. Webhook Handler (`webhook.ts`)**
HMAC-SHA256 verification before any payload parsing, followed by typed event dispatch. Handles `ORDER_PLACED` (reconcile order state), `CLOSE_TAB` (mark payment complete), and `ITEM_ADDED`/`ITEM_REMOVED` (inventory tracking). Each handler must be idempotent.

**4. Tab Mapping Layer** *(not yet implemented — would be next)*
Translates a Tapin order into a GoTab tab: maps Tapin's product IDs to GoTab product UUIDs, converts line items to the GoTab `items` format (catalog item vs open item), and handles tax rates. This is the integration's "impedance mismatch" layer and likely the most fragile long-term.

---

## Concerns I'd Raise Before Writing Any Code

### 1. Session Expiry Race Condition
GoTab's payment sessions expire (the API returns an `expires` timestamp). There's a window between when Tapin creates the session and when the client calls `initWallet()`. If the client is on a slow connection or the app sits in the background for a moment, the session can expire before the wallet initializes — and the SDK gives no explicit "session expired" error; it just fails opaquely.

**Mitigation:** Create the session as late as possible (immediately before returning it to the client, not during order creation). Apply a buffer check server-side before returning. If we detect we're near expiry, refresh proactively. Surface a clear `SESSION_EXPIRED` error to the client so it can retry gracefully.

### 2. Client-Side Credential Scope
The GoTab Payment SDK requires `clientApiAccessId` and `clientApiAccessSecret` to be passed in the browser. These are distinct from the server-side `api_access_id`/`api_access_secret` — but the documentation doesn't clearly state what operations client-side credentials can perform if compromised.

**Questions I'd want answered before shipping:** Can client-side credentials create sessions? Access other customers' payment methods? What's GoTab's revocation story? We should never expose server-side credentials to the client, but I'd want explicit confirmation from GoTab about the client-side credential blast radius.

### 3. Webhook Replay & Double-Payment
GoTab's webhook documentation doesn't specify their retry policy (how many times, what backoff, what triggers a retry). A `CLOSE_TAB` event delivered twice to a naive handler could trigger duplicate order fulfillment, double-send a confirmation, or mark an order complete before payment actually settled.

**Mitigation:** All webhook handlers must key on `tabUuid + eventType + createdAt` for deduplication. Store processed event hashes in a fast store (Redis or Postgres) with a TTL that outlasts any reasonable retry window. Respond HTTP 200 to GoTab on duplicate delivery; log it for observability.

### 4. Auth Token Lifecycle in Multi-Process Deployments
The in-memory `TokenCache` works fine for a single process. In a horizontally-scaled deployment, each instance independently fetches tokens — not catastrophic, but wasteful and could trigger rate limits on the auth endpoint if many instances restart simultaneously.

**Mitigation for production:** Move the token cache to Redis with an atomic check-and-set. One instance refreshes; all others read. Add alerting on auth failures so a credentials rotation doesn't silently break payments.

### 5. Tab Ownership Authorization
The `createSession` API accepts any `tabUuid`. Without explicit enforcement on Tapin's side, a malicious client could request a payment session for any tab at any location — even one belonging to a different user. GoTab may or may not reject this server-side; I wouldn't rely on it.

**Mitigation:** Before calling GoTab, verify in Tapin's own database that the requesting user's current active order maps to the requested `tabUuid`. This check must happen in the service layer, not just in the route handler, so it can't be bypassed by future callers.

---

## Questions I'd Want Answered Before Production

**On GoTab's side:**
1. **Webhook retries:** Does GoTab retry on non-2xx? What's the retry schedule and maximum attempts? This directly determines how aggressive our idempotency infrastructure needs to be.
2. **Rate limits:** What are the per-minute/per-hour limits on `/api/oauth/token` and `/payment-sessions`? We need this to size our caching strategy and set alerting thresholds.
3. **Sandbox environment:** Is there a staging base URL where we can trigger real payment flows without live money? The docs mention GoTab but no sandbox URL is clearly documented.
4. **Client-side credential scope:** Confirmed: what can `clientApiAccessId`/`clientApiAccessSecret` do if leaked? Can they call any server-side APIs?
5. **Tab lifecycle errors:** What's the full set of error codes when a payment session can't be created? (e.g., tab already closed, tab in dispute, tab balance is $0) We need to map these to user-facing messages.
6. **Partial payments / split tabs:** Does GoTab support partial payment sessions? If two Tapin users want to split a tab, does each get their own session, or is one session per tab?

**On Tapin's side (internal):**
7. **Product ID mapping:** How are Tapin's product IDs mapped to GoTab's `productUuid`? Is there a sync job or is it manual configuration per location?
8. **Multi-location:** Does each GoTab location have its own credential pair, or is there a single integration credential that spans locations?
9. **Refunds:** Should Tapin's backend handle refund webhooks, or is that handled directly in GoTab's operator dashboard?

---

## What I'd Prioritize (and Why)

I prioritized the payment session service and webhook handler over the tab creation and product mapping layers for one reason: **payment correctness is more important than payment initiation**.

You can always retry a tab creation. You cannot easily undo a double-charged card or a missed fulfillment trigger. The session service governs authorization and timing; the webhook handler governs what happens after money moves. Getting these two pieces right — typed errors, session validity windows, signature verification, idempotent dispatch — is where production incidents happen in payment integrations.

The tab mapping layer is more complex (impedance mismatch between Tapin's product model and GoTab's catalog) but its failure mode is less severe: the payment won't initiate, which is recoverable. An incorrect webhook handler or a race-conditioned session flow is harder to detect and harder to unwind.
