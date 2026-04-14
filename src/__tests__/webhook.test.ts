import { createHmac } from "crypto";
import {
  verifyWebhookSignature,
  WebhookHandler,
  WebhookSignatureError,
  UnknownWebhookEventError,
} from "../gotab/webhook";
import { WebhookHeaders, WebhookPayload, OrderPlacedData } from "../gotab/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WEBHOOK_SECRET = "super-secret-key";

function sign(body: string, secret = WEBHOOK_SECRET): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

function makeHeaders(
  body: string,
  eventType: string,
  secret = WEBHOOK_SECRET,
): WebhookHeaders {
  return {
    "x-gotab-event-type": eventType,
    "x-gotab-signature": sign(body, secret),
    "x-gotab-application-id": "tapin-app",
  };
}

// ---------------------------------------------------------------------------
// verifyWebhookSignature
// ---------------------------------------------------------------------------

describe("verifyWebhookSignature", () => {
  const body = JSON.stringify({ type: "ORDER_PLACED", createdAt: "2024-01-01T00:00:00Z", data: {} });

  it("returns { valid: true } for a correct signature", () => {
    const sig = sign(body);
    expect(verifyWebhookSignature(body, sig, WEBHOOK_SECRET)).toEqual({ valid: true });
  });

  it("returns { valid: false, reason: 'signature_mismatch' } for a wrong signature", () => {
    const badSig = sign(body, "wrong-secret");
    const result = verifyWebhookSignature(body, badSig, WEBHOOK_SECRET);
    expect(result).toEqual({ valid: false, reason: "signature_mismatch" });
  });

  it("returns { valid: false, reason: 'missing_signature' } when header is absent", () => {
    expect(verifyWebhookSignature(body, undefined, WEBHOOK_SECRET)).toEqual({
      valid: false,
      reason: "missing_signature",
    });
  });

  it("returns mismatch (not a crash) when the signature is not valid hex", () => {
    // Malformed header shouldn't throw — we just treat it as a mismatch
    const result = verifyWebhookSignature(body, "not-hex!!", WEBHOOK_SECRET);
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WebhookHandler
// ---------------------------------------------------------------------------

describe("WebhookHandler", () => {
  function makeOrderPayload(): WebhookPayload<OrderPlacedData> {
    return {
      type: "ORDER_PLACED",
      targetUuid: "order-uuid-1",
      locationUuid: "loc-123",
      createdAt: new Date().toISOString(),
      data: {
        created: new Date().toISOString(),
        orderName: "Order #1",
        scheduled: false,
        zoneName: "Patio",
        spotName: "Table 5",
        zoneTags: [],
        zoneGroupName: "Outdoor",
        total: 2400,
        tabUuid: "tab-abc",
        itemNames: ["Burger", "Fries"],
        itemTags: [],
        categoryNames: ["Food"],
      },
    };
  }

  it("dispatches ORDER_PLACED to the registered handler", async () => {
    const handler = new WebhookHandler({ secret: WEBHOOK_SECRET });
    const handlerFn = jest.fn().mockResolvedValue(undefined);
    handler.register("ORDER_PLACED", handlerFn);

    const payload = makeOrderPayload();
    const body = JSON.stringify(payload);
    const headers = makeHeaders(body, "ORDER_PLACED");

    await handler.process(body, headers);

    expect(handlerFn).toHaveBeenCalledTimes(1);
    expect(handlerFn).toHaveBeenCalledWith(
      expect.objectContaining({ type: "ORDER_PLACED" }),
    );
  });

  it("throws WebhookSignatureError before dispatching on an invalid signature", async () => {
    const handler = new WebhookHandler({ secret: WEBHOOK_SECRET });
    const handlerFn = jest.fn();
    handler.register("ORDER_PLACED", handlerFn);

    const payload = makeOrderPayload();
    const body = JSON.stringify(payload);
    const headers: WebhookHeaders = {
      "x-gotab-event-type": "ORDER_PLACED",
      "x-gotab-signature": "deadbeef", // wrong
    };

    await expect(handler.process(body, headers)).rejects.toThrow(WebhookSignatureError);
    expect(handlerFn).not.toHaveBeenCalled();
  });

  it("throws WebhookSignatureError when the signature header is missing", async () => {
    const handler = new WebhookHandler({ secret: WEBHOOK_SECRET });
    handler.register("ORDER_PLACED", jest.fn());

    const body = JSON.stringify(makeOrderPayload());
    const headers: WebhookHeaders = { "x-gotab-event-type": "ORDER_PLACED" };

    await expect(handler.process(body, headers)).rejects.toThrow(WebhookSignatureError);
  });

  it("throws UnknownWebhookEventError for an event type with no registered handler", async () => {
    const handler = new WebhookHandler({ secret: WEBHOOK_SECRET });
    // No handlers registered

    const payload = makeOrderPayload();
    const body = JSON.stringify(payload);
    const headers = makeHeaders(body, "ORDER_PLACED");

    await expect(handler.process(body, headers)).rejects.toThrow(UnknownWebhookEventError);
  });

  it("passes the full parsed payload to the handler", async () => {
    const handler = new WebhookHandler({ secret: WEBHOOK_SECRET });
    let received: WebhookPayload<OrderPlacedData> | null = null;

    handler.register<OrderPlacedData>("ORDER_PLACED", async (p) => {
      received = p;
    });

    const payload = makeOrderPayload();
    const body = JSON.stringify(payload);
    await handler.process(body, makeHeaders(body, "ORDER_PLACED"));

    expect(received).not.toBeNull();
    expect(received!.data.tabUuid).toBe("tab-abc");
    expect(received!.data.total).toBe(2400);
  });
});
