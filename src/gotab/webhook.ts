import { createHmac, timingSafeEqual } from "crypto";
import {
  WebhookHeaders,
  WebhookPayload,
  WebhookVerificationResult,
} from "./types";

// ---------------------------------------------------------------------------
// GoTab Webhook Verification & Dispatch
// https://docs.gotab.io/reference/webhooks
// ---------------------------------------------------------------------------

/**
 * Verifies the HMAC-SHA256 signature GoTab attaches to every webhook delivery.
 *
 * IMPORTANT: `rawBody` must be the exact bytes received over the wire — do NOT
 * parse and re-serialize the JSON before calling this. Even a single whitespace
 * difference will produce a different digest.
 *
 * We use `timingSafeEqual` to prevent timing-based signature oracle attacks.
 * A naive string equality check leaks information about how many leading bytes
 * matched, which could be exploited to forge signatures incrementally.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
): WebhookVerificationResult {
  if (!signatureHeader) {
    return { valid: false, reason: "missing_signature" };
  }

  const expected = createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("hex");

  // Both buffers must be the same length for timingSafeEqual — if they differ
  // in length the signature is definitely wrong, but we still avoid a short-
  // circuit that leaks the expected length.
  const expectedBuf = Buffer.from(expected, "hex");
  const receivedBuf = Buffer.from(signatureHeader, "hex");

  if (
    expectedBuf.length !== receivedBuf.length ||
    !timingSafeEqual(expectedBuf, receivedBuf)
  ) {
    return { valid: false, reason: "signature_mismatch" };
  }

  return { valid: true };
}

export class WebhookSignatureError extends Error {
  constructor(public readonly reason: string) {
    super(`Webhook signature verification failed: ${reason}`);
    this.name = "WebhookSignatureError";
  }
}

export class UnknownWebhookEventError extends Error {
  constructor(public readonly eventType: string) {
    super(`No handler registered for webhook event type: ${eventType}`);
    this.name = "UnknownWebhookEventError";
  }
}

type WebhookHandlerFn<T = Record<string, unknown>> = (
  payload: WebhookPayload<T>,
) => Promise<void>;

/**
 * Verifies and dispatches incoming GoTab webhooks to registered handlers.
 *
 * Usage:
 *   const handler = new WebhookHandler({ secret: process.env.GOTAB_WEBHOOK_SECRET! });
 *   handler.register("ORDER_PLACED", async (payload) => { ... });
 *   handler.register("CLOSE_TAB", async (payload) => { ... });
 *
 *   // In your HTTP route:
 *   await handler.process(rawBody, req.headers);
 *
 * On idempotency: GoTab's docs don't specify their retry behavior. Assume events
 * can be delivered more than once. Handlers should key on
 * `payload.targetUuid + payload.type + payload.createdAt` to deduplicate.
 */
export class WebhookHandler {
  private readonly secret: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly handlers = new Map<string, WebhookHandlerFn<any>>();

  constructor(config: { secret: string }) {
    this.secret = config.secret;
  }

  register<T>(eventType: string, handler: WebhookHandlerFn<T>): void {
    this.handlers.set(eventType, handler);
  }

  /**
   * Verifies the signature, parses the payload, and dispatches to the
   * registered handler for the event type.
   *
   * Throws `WebhookSignatureError` if verification fails — callers should
   * respond with HTTP 401 in that case.
   *
   * Throws `UnknownWebhookEventError` if no handler is registered — callers
   * can choose to respond 200 (silently ignore) or 400.
   */
  async process(rawBody: string, headers: WebhookHeaders): Promise<void> {
    // Signature verification happens before JSON.parse. If we parsed first and
    // passed the stringified result, any encoding difference (key ordering,
    // whitespace) would break the HMAC. Always verify over raw bytes.
    const verificationResult = verifyWebhookSignature(
      rawBody,
      headers["x-gotab-signature"],
      this.secret,
    );

    if (!verificationResult.valid) {
      throw new WebhookSignatureError(
        verificationResult.reason ?? "unknown",
      );
    }

    const payload = JSON.parse(rawBody) as WebhookPayload;
    const eventType = headers["x-gotab-event-type"] ?? payload.type;

    const handler = this.handlers.get(eventType);
    if (!handler) {
      throw new UnknownWebhookEventError(eventType);
    }

    await handler(payload);
  }
}
