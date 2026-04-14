// GoTab API types derived from https://docs.gotab.io/reference/

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface GoTabCredentials {
  apiAccessId: string;
  apiAccessSecret: string;
}

export interface GoTabToken {
  token: string;
  refreshToken: string;
  tokenType: string;
  /** Unix timestamp (seconds) when the token was issued */
  initiated: number;
  /** Unix timestamp (seconds) when the token expires */
  expires: number;
  /** Seconds until expiry from issuance */
  expiresIn: number;
}

// ---------------------------------------------------------------------------
// Payment Session
// ---------------------------------------------------------------------------

export interface PaymentSession {
  paymentSessionId: string;
  /** ISO 8601 datetime string */
  expires: string;
}

export interface GoTabApiError {
  type: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface GoTabApiWarning {
  type: string;
  message: string;
}

/** Standard GoTab REST response envelope */
export interface GoTabResponse<T> {
  data: T;
  warnings: GoTabApiWarning[];
  errors: GoTabApiError[];
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/** Headers GoTab sends on every webhook delivery */
export interface WebhookHeaders {
  "x-gotab-event-type": string;
  "x-gotab-signature"?: string;
  "x-gotab-event-target-uuid"?: string;
  "x-gotab-application-id"?: string;
  [key: string]: string | undefined;
}

export interface WebhookPayload<T = Record<string, unknown>> {
  type: string;
  targetUuid?: string;
  targetId?: string;
  locationUuid?: string;
  locationName?: string;
  locationId?: string;
  /** ISO 8601 datetime string */
  createdAt: string;
  data: T;
}

export interface OrderPlacedData {
  created: string;
  orderName: string;
  scheduled: boolean;
  zoneName: string;
  spotName: string;
  zoneTags: string[];
  zoneGroupName: string;
  total: number;
  tabUuid: string;
  itemNames: string[];
  itemTags: string[];
  categoryNames: string[];
}

export interface CloseTabData {
  // GoTab sends an empty data object for CLOSE_TAB
}

export interface ItemAddedData {
  orderId: string;
  productId: string;
  name: string;
  productName: string;
  categoryName: string;
  quantity: number;
  price: number;
  tags: string[];
  tabId: string;
  tabUuid: string;
}

export type WebhookEventType =
  | "ORDER_PLACED"
  | "CLOSE_TAB"
  | "OPEN_TAB"
  | "ITEM_ADDED"
  | "ITEM_REMOVED"
  | "MENU_UPDATED"
  | "PRODUCT_UPDATED"
  | "GUEST_VERIFIED"
  | "GUEST_SUBSCRIBED"
  | "GUEST_UNSUBSCRIBED"
  | "QR_SCANNED"
  | "LOCATION_UPDATED"
  | "CATEGORY_UPDATED";

export interface WebhookVerificationResult {
  valid: boolean;
  reason?: "missing_signature" | "signature_mismatch";
}
