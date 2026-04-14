# Tapin × GoTab Payment Integration

Backend module for Tapin's GoTab payment integration. Written in TypeScript, no framework required.

## Running the Tests

```bash
npm install
npm test
```

Requires Node 18+.

## What's Here

```
src/gotab/
  types.ts           — GoTab API TypeScript interfaces
  auth.ts            — Token fetch + in-memory cache (60s pre-expiry refresh)
  payment-session.ts — Payment session creation + validity check
  webhook.ts         — HMAC-SHA256 verification + event dispatcher
src/__tests__/
  payment-session.test.ts  — 9 tests: happy path, error handling, caching, validity window
  webhook.test.ts          — 8 tests: signature verify, dispatch, error cases
DESIGN.md            — Part 1 system design writeup
```

## What I Chose to Build (and Why)

I implemented the **payment session service** and **webhook handler** as the two most critical backend components.

The payment session service is the only server-side API call required before any payment can begin. It's also the right place to enforce tab ownership (verifying the requesting user's order maps to the `tabUuid` before calling GoTab) and to manage auth token caching. Getting session creation and validity right directly prevents the most common failure mode: a client receiving an already-expired session.

The webhook handler is where payment outcomes land. GoTab's retry behavior isn't documented, so I built explicit HMAC-SHA256 verification (with timing-safe comparison) and a typed event dispatcher that supports idempotent handlers. The `UnknownWebhookEventError` path means unregistered events fail loudly — preferrable to silently discarding events that turn out to matter.

I did **not** implement the tab creation and product mapping layer. That's the more complex piece (impedance mismatch between Tapin's product model and GoTab's catalog), but its failure mode is recoverable: the payment doesn't initiate. The session and webhook layers govern correctness after money moves — harder to undo if wrong.

See `DESIGN.md` for the full written design, concerns, and pre-production questions.

## Environment Variables (production)

```
GOTAB_API_ACCESS_ID=...
GOTAB_API_ACCESS_SECRET=...
GOTAB_LOCATION_UUID=...
GOTAB_WEBHOOK_SECRET=...
```

No credentials are needed to run the tests — the HTTP client is dependency-injected and fully mocked.
