import type { PaymentRequestLifecycleEvent, PaymentRequestStatus } from "@sdp/types";
import type { AppDb } from "@/db";
import { internalError } from "@/lib/errors";
import type {
  CreatePaymentRequestInput,
  ListPaymentRequestsInput,
  ListPaymentRequestsResult,
  MarkPaymentRequestInput,
  PaymentRequestRow,
  PaymentRequestsRepository,
} from "./payment-requests.repository";
import { generatePaymentRequestId } from "./payment-requests.repository";

function mapPaymentRequestRow(row: Record<string, unknown>): PaymentRequestRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    project_id: row.project_id as string | null,
    counterparty_id: row.counterparty_id as string | null,
    wallet_id: row.wallet_id as string,
    destination_address: row.destination_address as string,
    token: row.token as string,
    amount: row.amount as string,
    reference: row.reference as string,
    status: row.status as PaymentRequestStatus,
    expires_at: row.expires_at as string | null,
    fulfilled_by_transfer_id: row.fulfilled_by_transfer_id as string | null,
    canceled_by: row.canceled_by as string | null,
    lifecycle: row.lifecycle as PaymentRequestLifecycleEvent[],
    created_by: row.created_by as string | null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function createPostgresPaymentRequestsRepository(db: AppDb): PaymentRequestsRepository {
  return {
    async createPaymentRequest(input: CreatePaymentRequestInput) {
      const id = generatePaymentRequestId();

      const row = await db
        .prepare(
          `INSERT INTO payment_requests (
             id,
             organization_id,
             project_id,
             counterparty_id,
             wallet_id,
             destination_address,
             token,
             amount,
             reference,
             expires_at,
             created_by,
             lifecycle
           ) VALUES (
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             jsonb_build_array(jsonb_build_object('status', 'awaiting_payment', 'at', sdp_iso_now()))
           )
           RETURNING *`
        )
        .bind(
          id,
          input.organizationId,
          input.projectId,
          input.counterpartyId,
          input.walletId,
          input.destinationAddress,
          input.token,
          input.amount,
          input.reference,
          input.expiresAt,
          input.createdBy
        )
        .first<Record<string, unknown>>();

      if (!row) {
        throw internalError("payment_requests INSERT ... RETURNING returned no row");
      }
      return mapPaymentRequestRow(row);
    },

    async markPaymentRequest(input: MarkPaymentRequestInput) {
      const row = await db
        .prepare(
          `UPDATE payment_requests
             SET status = ?,
                 fulfilled_by_transfer_id = COALESCE(?, fulfilled_by_transfer_id),
                 canceled_by = ?,
                 lifecycle = lifecycle || jsonb_build_array(
                   jsonb_build_object('status', ?::text, 'at', sdp_iso_now())
                 ),
                 updated_at = sdp_iso_now()
           WHERE id = ?
             AND organization_id = ?
             AND project_id = ?
             AND status = 'awaiting_payment'
           RETURNING *`
        )
        .bind(
          input.status,
          input.fulfilledByTransferId,
          input.canceledBy,
          input.status,
          input.requestId,
          input.organizationId,
          input.projectId
        )
        .first<Record<string, unknown>>();

      return row ? mapPaymentRequestRow(row) : null;
    },

    async getPaymentRequestById(params) {
      const row = await db
        .prepare(
          `SELECT * FROM payment_requests
             WHERE id = ?
               AND organization_id = ?
               AND project_id = ?`
        )
        .bind(params.requestId, params.organizationId, params.projectId)
        .first<Record<string, unknown>>();
      return row ? mapPaymentRequestRow(row) : null;
    },

    async listPaymentRequests(
      params: ListPaymentRequestsInput
    ): Promise<ListPaymentRequestsResult> {
      const [rowsResult, countRow] = await Promise.all([
        db
          .prepare(
            `SELECT *
               FROM payment_requests
              WHERE organization_id = ?
                AND project_id = ?
                AND (?::text IS NULL OR status = ?::text)
              ORDER BY created_at DESC
              LIMIT ? OFFSET ?`
          )
          .bind(
            params.organizationId,
            params.projectId,
            params.status ?? null,
            params.status ?? null,
            params.limit,
            params.offset
          )
          .all<Record<string, unknown>>(),
        db
          .prepare(
            `SELECT COUNT(*)::int AS total
               FROM payment_requests
              WHERE organization_id = ?
                AND project_id = ?
                AND (?::text IS NULL OR status = ?::text)`
          )
          .bind(
            params.organizationId,
            params.projectId,
            params.status ?? null,
            params.status ?? null
          )
          .first<{ total: number }>(),
      ]);

      if (!countRow) {
        throw internalError("payment_requests COUNT returned no row");
      }
      return {
        rows: rowsResult.results.map(mapPaymentRequestRow),
        total: countRow.total,
      };
    },
  };
}
