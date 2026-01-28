/**
 * Signing Request Store
 *
 * Persistence for async custody signing requests.
 */

import type { SignatureStatus, SigningRequestRecord } from "./types";

export class SigningRequestStore {
  constructor(private db: D1Database) {}

  async findByIdOrExternal(requestId: string): Promise<SigningRequestRecord | null> {
    return this.db
      .prepare("SELECT * FROM signing_requests WHERE id = ? OR external_request_id = ?")
      .bind(requestId, requestId)
      .first<SigningRequestRecord>();
  }

  async create(params: {
    organizationId: string;
    custodyConfigId: string;
    externalRequestId?: string;
    tokenTransactionId?: string;
    transactionMessage: string;
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    const id = `sig_${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    await this.db
      .prepare(
        `INSERT INTO signing_requests
         (id, organization_id, custody_config_id, token_transaction_id, external_request_id,
          status, transaction_message, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
      )
      .bind(
        id,
        params.organizationId,
        params.custodyConfigId,
        params.tokenTransactionId ?? null,
        params.externalRequestId ?? null,
        params.transactionMessage,
        params.metadata ? JSON.stringify(params.metadata) : null,
        now
      )
      .run();

    return id;
  }

  async updateStatus(id: string, status: SignatureStatus): Promise<void> {
    const now = new Date().toISOString();

    if (status.status === "completed") {
      await this.db
        .prepare(
          `UPDATE signing_requests
           SET status = 'completed', signatures = ?, completed_at = ?
           WHERE id = ?`
        )
        .bind(JSON.stringify(status.signatures), now, id)
        .run();
      return;
    }

    if (status.status === "rejected" || status.status === "failed") {
      await this.db
        .prepare(
          `UPDATE signing_requests
           SET status = ?, completed_at = ?
           WHERE id = ?`
        )
        .bind(status.status, now, id)
        .run();
    }
  }
}
