// Email-delivery idempotency claims. NOT an attempt log (that's webhook_deliveries):
// this table exists so a retried producer cannot re-send an email — the counterpart of
// the in-app store's (user_id, dedupe_key) unique index.
//
// Lifecycle: claim() inserts a 'pending' row (or reclaims a 'failed' one) and returns
// its id; the caller sends, then markSent/markFailed. 'sent' and in-flight 'pending'
// rows refuse the claim. A crash between claim and send strands a 'pending' row, so
// email is at-most-once — the in-app row is the durable truth.

export function generateNotificationDeliveryId(): string {
  return `ndel_${crypto.randomUUID()}`;
}

export interface NotificationDeliveryRow {
  id: string;
  organization_id: string;
  user_id: string | null;
  channel: string;
  recipient: string;
  dedupe_key: string;
  status: string;
  provider_message_id: string | null;
  error: string | null;
  attempt_count: number;
  created_at: string;
  updated_at: string;
}

export interface ClaimNotificationDeliveryInput {
  organizationId: string;
  // NULL for sends without a platform recipient (direct-address, counterparty receipts).
  userId: string | null;
  channel: "email";
  recipient: string;
  dedupeKey: string;
}

export interface NotificationDeliveriesRepository {
  // Returns the claimed row id, or null when the send is already owned (sent/pending).
  claim(input: ClaimNotificationDeliveryInput): Promise<string | null>;
  markSent(params: { id: string; providerMessageId: string | null }): Promise<void>;
  markFailed(params: { id: string; error: string }): Promise<void>;
}
