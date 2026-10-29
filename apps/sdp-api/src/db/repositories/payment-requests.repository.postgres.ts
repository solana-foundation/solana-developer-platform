import type {
  ClosedUnpaidPaymentRequestStatus,
  PaymentRequestLifecycleEvent,
  PaymentRequestStatus,
} from "@sdp/types/payments";
import { z } from "zod";
import type { DatabaseClient as AppDb } from "@/db/client";
import { internalError } from "@/lib/errors";
import { parseNullableCustodyWalletId } from "./payment-execution-identity";
import type {
  AdvanceSignatureScanInput,
  CancelPaymentRequestInput,
  CreatePaymentRequestInput,
  ListPaymentRequestsInput,
  ListPaymentRequestsResult,
  MarkClosedPaymentRequestPaidInput,
  MarkPaymentRequestInput,
  PaymentRequestRow,
  PaymentRequestsRepository,
} from "./payment-requests.repository";
import {
  generatePaymentRequestId,
  generatePaymentRequestPublicToken,
  generatePaymentRequestReference,
  SETTLEMENT_BLOCKED_REASONS,
} from "./payment-requests.repository";

const reconcilerColumnsSchema = z.object({
  project_id: z.string(),
  last_checked_at: z.string().nullable(),
  last_verified_at: z.string().nullable(),
  settlement_blocked_reason: z.enum(SETTLEMENT_BLOCKED_REASONS).nullable(),
  paid_late: z.boolean(),
  signature_scan_cursor: z.string().nullable(),
  signature_scan_before: z.string().nullable(),
  signature_scan_stuck_signature: z.string().nullable(),
  signature_scan_stuck_since: z.string().nullable(),
  canceled_at: z.string().nullable(),
  canceled_by_api_key_id: z.string().nullable(),
  canceled_by_user_id: z.string().nullable(),
  sponsored_tx_last_valid_block_height: z.coerce.bigint().nullable(),
});

function mapPaymentRequestRow(row: Record<string, unknown>): PaymentRequestRow {
  const parsed = reconcilerColumnsSchema.safeParse(row);
  if (!parsed.success) {
    throw internalError("payment request row has malformed reconciler columns");
  }
  const reconciler = parsed.data;
  return {
    id: row.id as string,
    public_token: row.public_token as string,
    organization_id: row.organization_id as string,
    project_id: reconciler.project_id,
    custody_wallet_id: parseNullableCustodyWalletId(row.custody_wallet_id),
    wallet_id: row.wallet_id as string,
    destination_address: row.destination_address as string,
    token: row.token as string,
    amount: row.amount as string,
    reference: row.reference as string,
    status: row.status as PaymentRequestStatus,
    expires_at: row.expires_at as string | null,
    fulfilled_by_transfer_id: row.fulfilled_by_transfer_id as string | null,
    canceled_by_api_key_id: reconciler.canceled_by_api_key_id,
    canceled_by_user_id: reconciler.canceled_by_user_id,
    canceled_at: reconciler.canceled_at,
    lifecycle: row.lifecycle as PaymentRequestLifecycleEvent[],
    created_by: row.created_by as string | null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    last_checked_at: reconciler.last_checked_at,
    last_verified_at: reconciler.last_verified_at,
    settlement_blocked_reason: reconciler.settlement_blocked_reason,
    paid_late: reconciler.paid_late,
    signature_scan_cursor: reconciler.signature_scan_cursor,
    signature_scan_before: reconciler.signature_scan_before,
    signature_scan_stuck_signature: reconciler.signature_scan_stuck_signature,
    signature_scan_stuck_since: reconciler.signature_scan_stuck_since,
    sponsored_tx_last_valid_block_height: reconciler.sponsored_tx_last_valid_block_height,
  };
}

/**
 * Settle a request that closed without a payment, compare-and-set from the status it closed in.
 * The rest of the row, who canceled it and when included, stays as it was.
 *
 * @param db - The client to run on: the root client or the settlement's transaction.
 * @param input - The request, its settling transfer, and whether the payment landed late.
 * @param from - The closed status the request must still be in.
 * @returns The paid row, or null when the request was no longer in `from`.
 */
async function markClosedPaymentRequestPaid(
  db: AppDb,
  input: MarkClosedPaymentRequestPaidInput,
  from: ClosedUnpaidPaymentRequestStatus
): Promise<PaymentRequestRow | null> {
  const row = await db
    .prepare(
      `UPDATE payment_requests
         SET status = 'paid',
             paid_late = ?,
             fulfilled_by_transfer_id = ?,
             lifecycle = lifecycle || jsonb_build_array(
               jsonb_build_object('status', 'paid', 'at', sdp_iso_now())
             ),
             last_checked_at = sdp_iso_now(),
             last_verified_at = sdp_iso_now(),
             updated_at = sdp_iso_now()
       WHERE id = ?
         AND organization_id = ?
         AND project_id = ?
         AND status = ?
       RETURNING *`
    )
    .bind(
      input.paidLate,
      input.fulfilledByTransferId,
      input.requestId,
      input.organizationId,
      input.projectId,
      from
    )
    .first<Record<string, unknown>>();
  return row ? mapPaymentRequestRow(row) : null;
}

function paymentRequestStatusFilter(status: PaymentRequestStatus | undefined): {
  sql: string;
  binds: string[];
} {
  switch (status) {
    case undefined:
      return { sql: "TRUE", binds: [] };
    case "awaiting_payment":
      return {
        sql: "status = 'awaiting_payment' AND (expires_at IS NULL OR expires_at > sdp_iso_now())",
        binds: [],
      };
    case "expired":
      return {
        sql: "(status = 'expired' OR (status = 'awaiting_payment' AND expires_at IS NOT NULL AND expires_at <= sdp_iso_now()))",
        binds: [],
      };
    default:
      return { sql: "status = ?", binds: [status] };
  }
}

export function createPostgresPaymentRequestsRepository(db: AppDb): PaymentRequestsRepository {
  return {
    async createPaymentRequest(input: CreatePaymentRequestInput) {
      const id = generatePaymentRequestId();
      const publicToken = generatePaymentRequestPublicToken();
      const reference = await generatePaymentRequestReference();

      const row = await db
        .prepare(
          `INSERT INTO payment_requests (
             id,
             public_token,
             organization_id,
             project_id,
             custody_wallet_id,
             wallet_id,
             destination_address,
             token,
             amount,
             reference,
             expires_at,
             created_by,
             lifecycle
           ) VALUES (
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             jsonb_build_array(jsonb_build_object('status', 'awaiting_payment', 'at', sdp_iso_now()))
           )
           RETURNING *`
        )
        .bind(
          id,
          publicToken,
          input.organizationId,
          input.projectId,
          input.custodyWalletId,
          input.walletId,
          input.destinationAddress,
          input.token,
          input.amount,
          reference,
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
                 paid_late = ?,
                 lifecycle = lifecycle || jsonb_build_array(
                   jsonb_build_object('status', ?::text, 'at', sdp_iso_now())
                 ),
                 last_checked_at = sdp_iso_now(),
                 last_verified_at = CASE WHEN ?::boolean THEN sdp_iso_now() ELSE last_verified_at END,
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
          input.paidLate,
          input.status,
          input.chainRead,
          input.requestId,
          input.organizationId,
          input.projectId
        )
        .first<Record<string, unknown>>();

      return row ? mapPaymentRequestRow(row) : null;
    },

    async cancelPaymentRequest(input: CancelPaymentRequestInput) {
      const row = await db
        .prepare(
          // A sponsored transaction is a bearer instrument until its blockhash expires: the
          // request stays open while one can still land, as the expiry lane holds a lapsed one.
          `UPDATE payment_requests
             SET status = 'canceled',
                 canceled_by_api_key_id = ?,
                 canceled_by_user_id = ?,
                 canceled_at = sdp_iso_now(),
                 lifecycle = lifecycle || jsonb_build_array(
                   jsonb_build_object('status', 'canceled', 'at', sdp_iso_now())
                 ),
                 updated_at = sdp_iso_now()
           WHERE id = ?
             AND organization_id = ?
             AND project_id = ?
             AND status = 'awaiting_payment'
             AND (expires_at IS NULL OR expires_at > sdp_iso_now())
             AND (
               sponsored_tx_last_valid_block_height IS NULL
               OR sponsored_tx_last_valid_block_height < ?::bigint
             )
           RETURNING *`
        )
        .bind(
          input.canceledBy.apiKeyId,
          input.canceledBy.userId,
          input.requestId,
          input.organizationId,
          input.projectId,
          input.liveClaimMinLastValidBlockHeight === null
            ? null
            : input.liveClaimMinLastValidBlockHeight.toString()
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

    async claimSponsoredTransactionWindow(params) {
      const row = await db
        .prepare(
          `UPDATE payment_requests
             SET sponsored_tx_account = ?,
                 sponsored_tx_unsigned = ?,
                 sponsored_tx_signed = NULL,
                 sponsored_tx_last_valid_block_height = ?,
                 updated_at = sdp_iso_now()
           WHERE id = ?
             AND status = 'awaiting_payment'
             AND (expires_at IS NULL OR expires_at > sdp_iso_now())
             AND (
               sponsored_tx_last_valid_block_height IS NULL
               OR sponsored_tx_last_valid_block_height < ?
             )
           RETURNING id`
        )
        .bind(
          params.account,
          params.unsignedTransaction,
          params.lastValidBlockHeight.toString(),
          params.requestId,
          params.currentBlockHeight.toString()
        )
        .first<{ id: string }>();
      return row !== null;
    },

    async getSponsoredTransactionClaim(requestId) {
      const row = await db
        .prepare(
          `SELECT sponsored_tx_account, sponsored_tx_unsigned, sponsored_tx_signed,
                  sponsored_tx_last_valid_block_height
             FROM payment_requests
            WHERE id = ?`
        )
        .bind(requestId)
        .first<{
          sponsored_tx_account: string | null;
          sponsored_tx_unsigned: string | null;
          sponsored_tx_signed: string | null;
          sponsored_tx_last_valid_block_height: string | number | null;
        }>();
      if (!row || row.sponsored_tx_account === null) {
        return null;
      }
      if (row.sponsored_tx_unsigned === null || row.sponsored_tx_last_valid_block_height === null) {
        throw internalError("payment_requests sponsored claim row is missing claim fields");
      }
      return {
        account: row.sponsored_tx_account,
        unsignedTransaction: row.sponsored_tx_unsigned,
        signedTransaction: row.sponsored_tx_signed,
        lastValidBlockHeight: BigInt(row.sponsored_tx_last_valid_block_height),
      };
    },

    async storeSponsoredTransactionSignature(params) {
      const changed = await db
        .prepare(
          `UPDATE payment_requests
             SET sponsored_tx_signed = ?, updated_at = sdp_iso_now()
           WHERE id = ?
             AND sponsored_tx_account = ?
             AND sponsored_tx_unsigned = ?
             AND sponsored_tx_signed IS NULL`
        )
        .bind(
          params.signedTransaction,
          params.requestId,
          params.account,
          params.unsignedTransaction
        )
        .run();
      return changed > 0;
    },

    async getPaymentRequestByPublicToken(publicToken) {
      const row = await db
        .prepare(`SELECT * FROM payment_requests WHERE public_token = ?`)
        .bind(publicToken)
        .first<Record<string, unknown>>();
      return row ? mapPaymentRequestRow(row) : null;
    },

    async listPaymentRequests(
      params: ListPaymentRequestsInput
    ): Promise<ListPaymentRequestsResult> {
      const filter = paymentRequestStatusFilter(params.status);
      const where = `WHERE organization_id = ? AND project_id = ? AND ${filter.sql}`;
      const scopeBinds = [params.organizationId, params.projectId, ...filter.binds];

      const [rowsResult, countRow] = await Promise.all([
        db
          .prepare(
            `SELECT * FROM payment_requests ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
          )
          .bind(...scopeBinds, params.limit, params.offset)
          .all<Record<string, unknown>>(),
        db
          .prepare(`SELECT COUNT(*)::int AS total FROM payment_requests ${where}`)
          .bind(...scopeBinds)
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

    async hasHotPaymentRequests({ environment }) {
      const row = await db
        .prepare(
          `SELECT 1 AS present FROM payment_requests pr
             JOIN projects p ON p.id = pr.project_id
            WHERE p.environment = ?
              AND pr.status = 'awaiting_payment'
              AND pr.custody_wallet_id IS NOT NULL
              AND pr.sponsored_tx_last_valid_block_height IS NOT NULL
              AND (pr.expires_at IS NULL OR pr.expires_at > sdp_iso_now())
            LIMIT 1`
        )
        .bind(environment)
        .first<{ present: number }>();
      return row !== null;
    },

    async listHotPaymentRequests({ environment, minLastValidBlockHeight, limit }) {
      const result = await db
        .prepare(
          `SELECT pr.* FROM payment_requests pr
             JOIN projects p ON p.id = pr.project_id
            WHERE p.environment = ?
              AND pr.status = 'awaiting_payment'
              AND pr.custody_wallet_id IS NOT NULL
              AND pr.sponsored_tx_last_valid_block_height >= ?
              AND (pr.expires_at IS NULL OR pr.expires_at > sdp_iso_now())
            ORDER BY pr.last_checked_at ASC NULLS FIRST, pr.created_at ASC, pr.id ASC
            LIMIT ?`
        )
        .bind(environment, minLastValidBlockHeight.toString(), limit)
        .all<Record<string, unknown>>();
      return result.results.map(mapPaymentRequestRow);
    },

    async listPaymentRequestsDueForCheck({
      environment,
      recentCheckedBefore,
      agedCheckedBefore,
      agedCreatedBefore,
      limit,
    }) {
      const result = await db
        .prepare(
          `SELECT pr.* FROM payment_requests pr
             JOIN projects p ON p.id = pr.project_id
            WHERE p.environment = ?
              AND pr.status = 'awaiting_payment'
              AND pr.custody_wallet_id IS NOT NULL
              AND (pr.expires_at IS NULL OR pr.expires_at > sdp_iso_now())
              AND (
                pr.last_checked_at IS NULL
                OR (pr.created_at >= ? AND pr.last_checked_at < ?)
                OR (pr.created_at < ? AND pr.last_checked_at < ?)
              )
            ORDER BY pr.last_checked_at ASC NULLS FIRST, pr.created_at ASC, pr.id ASC
            LIMIT ?`
        )
        .bind(
          environment,
          agedCreatedBefore,
          recentCheckedBefore,
          agedCreatedBefore,
          agedCheckedBefore,
          limit
        )
        .all<Record<string, unknown>>();
      return result.results.map(mapPaymentRequestRow);
    },

    async hasLapsedPaymentRequests({ environment, checkedBefore }) {
      const row = await db
        .prepare(
          `SELECT 1 AS present FROM payment_requests pr
             JOIN projects p ON p.id = pr.project_id
            WHERE p.environment = ?
              AND pr.status = 'awaiting_payment'
              AND pr.expires_at IS NOT NULL
              AND pr.expires_at <= sdp_iso_now()
              AND (pr.last_checked_at IS NULL OR pr.last_checked_at < ?)
            LIMIT 1`
        )
        .bind(environment, checkedBefore)
        .first<{ present: number }>();
      return row !== null;
    },

    async listLapsedPaymentRequests({
      environment,
      checkedBefore,
      liveClaimMinLastValidBlockHeight,
      limit,
    }) {
      const result = await db
        .prepare(
          `SELECT pr.* FROM payment_requests pr
             JOIN projects p ON p.id = pr.project_id
            WHERE p.environment = ?
              AND pr.status = 'awaiting_payment'
              AND pr.expires_at IS NOT NULL
              AND pr.expires_at <= sdp_iso_now()
              AND (pr.last_checked_at IS NULL OR pr.last_checked_at < ?)
              AND (
                pr.sponsored_tx_last_valid_block_height IS NULL
                OR pr.sponsored_tx_last_valid_block_height < ?
              )
            ORDER BY pr.last_checked_at ASC NULLS FIRST, pr.expires_at ASC, pr.id ASC
            LIMIT ?`
        )
        .bind(environment, checkedBefore, liveClaimMinLastValidBlockHeight.toString(), limit)
        .all<Record<string, unknown>>();
      return result.results.map(mapPaymentRequestRow);
    },

    async listClosedPaymentRequestsForLateCheck({
      environment,
      closedSince,
      checkedBefore,
      limit,
    }) {
      const result = await db
        .prepare(
          `SELECT pr.* FROM payment_requests pr
             JOIN projects p ON p.id = pr.project_id
            WHERE p.environment = ?
              AND (
                (pr.status = 'expired' AND (pr.expires_at >= ? OR pr.signature_scan_stuck_signature IS NOT NULL))
                OR (pr.status = 'canceled' AND (pr.canceled_at >= ? OR pr.signature_scan_stuck_signature IS NOT NULL))
              )
              AND pr.custody_wallet_id IS NOT NULL
              AND (pr.last_checked_at IS NULL OR pr.last_checked_at < ?)
            ORDER BY pr.last_checked_at ASC NULLS FIRST, COALESCE(pr.canceled_at, pr.expires_at) ASC, pr.id ASC
            LIMIT ?`
        )
        .bind(environment, closedSince, closedSince, checkedBefore, limit)
        .all<Record<string, unknown>>();
      return result.results.map(mapPaymentRequestRow);
    },

    async markPaymentRequestsChecked(checks) {
      if (checks.length === 0) {
        return;
      }
      await db
        .prepare(
          `UPDATE payment_requests AS pr
              SET last_checked_at = sdp_iso_now(),
                  last_verified_at = CASE WHEN c.kind = 'read' THEN sdp_iso_now() ELSE pr.last_verified_at END,
                  settlement_blocked_reason = CASE c.kind
                    WHEN 'blocked' THEN c.reason
                    WHEN 'skipped' THEN pr.settlement_blocked_reason
                    ELSE NULL
                  END
             FROM jsonb_to_recordset(?::jsonb) AS c(id text, kind text, reason text)
            WHERE pr.id = c.id`
        )
        .bind(
          JSON.stringify(
            checks.map((check) => ({
              id: check.id,
              kind: check.outcome.kind,
              reason: check.outcome.kind === "blocked" ? check.outcome.reason : null,
            }))
          )
        )
        .run();
    },

    async markExpiredPaymentRequestPaid(input: MarkClosedPaymentRequestPaidInput) {
      return markClosedPaymentRequestPaid(db, input, "expired");
    },

    async markCanceledPaymentRequestPaid(input: MarkClosedPaymentRequestPaidInput) {
      return markClosedPaymentRequestPaid(db, input, "canceled");
    },

    async advanceSignatureScan(input: AdvanceSignatureScanInput) {
      const changed = await db
        .prepare(
          `UPDATE payment_requests
             SET signature_scan_cursor = ?,
                 signature_scan_before = ?,
                 signature_scan_stuck_signature = ?,
                 signature_scan_stuck_since = ?
           WHERE id = ?
             AND organization_id = ?
             AND project_id = ?
             AND signature_scan_cursor IS NOT DISTINCT FROM ?
             AND signature_scan_before IS NOT DISTINCT FROM ?
             AND signature_scan_stuck_signature IS NOT DISTINCT FROM ?
             AND signature_scan_stuck_since IS NOT DISTINCT FROM ?`
        )
        .bind(
          input.to.cursor,
          input.to.before,
          input.to.stuckSignature,
          input.to.stuckSince,
          input.requestId,
          input.organizationId,
          input.projectId,
          input.from.cursor,
          input.from.before,
          input.from.stuckSignature,
          input.from.stuckSince
        )
        .run();
      return changed > 0;
    },

    async countStaleAwaitingPaymentRequests({ environment, checkedBefore }) {
      const row = await db
        .prepare(
          `SELECT COUNT(*)::int AS stale FROM payment_requests pr
             JOIN projects p ON p.id = pr.project_id
            WHERE p.environment = ?
              AND pr.status = 'awaiting_payment'
              AND pr.custody_wallet_id IS NOT NULL
              AND (pr.expires_at IS NULL OR pr.expires_at > sdp_iso_now())
              AND pr.settlement_blocked_reason IS NULL
              AND COALESCE(pr.last_verified_at, pr.created_at) < ?`
        )
        .bind(environment, checkedBefore)
        .first<{ stale: number }>();
      if (!row) {
        throw internalError("payment_requests stale COUNT returned no row");
      }
      return row.stale;
    },

    async countStaleLapsedPaymentRequests({ environment, checkedBefore }) {
      const row = await db
        .prepare(
          `SELECT COUNT(*)::int AS stale FROM payment_requests pr
             JOIN projects p ON p.id = pr.project_id
            WHERE p.environment = ?
              AND pr.status = 'awaiting_payment'
              AND pr.custody_wallet_id IS NOT NULL
              AND pr.expires_at IS NOT NULL
              AND pr.expires_at <= sdp_iso_now()
              AND COALESCE(pr.last_verified_at, pr.expires_at) < ?`
        )
        .bind(environment, checkedBefore)
        .first<{ stale: number }>();
      if (!row) {
        throw internalError("payment_requests lapsed stale COUNT returned no row");
      }
      return row.stale;
    },

    async countStaleLateWatchPaymentRequests({ environment, closedSince, checkedBefore }) {
      const row = await db
        .prepare(
          `SELECT COUNT(*)::int AS stale FROM payment_requests pr
             JOIN projects p ON p.id = pr.project_id
            WHERE p.environment = ?
              AND (
                (pr.status = 'expired' AND (pr.expires_at >= ? OR pr.signature_scan_stuck_signature IS NOT NULL))
                OR (pr.status = 'canceled' AND (pr.canceled_at >= ? OR pr.signature_scan_stuck_signature IS NOT NULL))
              )
              AND pr.custody_wallet_id IS NOT NULL
              AND pr.settlement_blocked_reason IS NULL
              AND COALESCE(pr.last_verified_at, pr.updated_at) < ?`
        )
        .bind(environment, closedSince, closedSince, checkedBefore)
        .first<{ stale: number }>();
      if (!row) {
        throw internalError("payment_requests late-watch stale COUNT returned no row");
      }
      return row.stale;
    },
  };
}
