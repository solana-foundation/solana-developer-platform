import { parseBaseUnits } from "@sdp/solana/token-amount";
import {
  PAYMENT_REQUEST_TRANSACTION_OUTCOMES,
  type PaymentRequestLifecycleEvent,
  type PaymentRequestStatus,
} from "@sdp/types/payments";
import { TOKEN_PROGRAM_KINDS } from "@sdp/types/well-known-tokens";
import { address, assertIsSignature } from "@solana/kit";
import { z } from "zod";
import type { DatabaseClient as AppDb } from "@/db/client";
import { internalError } from "@/lib/errors";
import { parseNullableCustodyWalletId } from "./payment-execution-identity";
import type {
  AdvanceSignatureScanInput,
  CreatePaymentRequestInput,
  ListPaymentRequestsInput,
  ListPaymentRequestsResult,
  MarkExpiredPaymentRequestPaidInput,
  MarkPaymentRequestInput,
  PaymentRequestExpectation,
  PaymentRequestRow,
  PaymentRequestsRepository,
  PaymentRequestTransaction,
  SignedPaymentRequestTransaction,
} from "./payment-requests.repository";
import {
  generatePaymentRequestId,
  generatePaymentRequestPublicToken,
  generatePaymentRequestReference,
  SETTLEMENT_BLOCKED_REASONS,
} from "./payment-requests.repository";
import {
  parseRecordedLegQuote,
  RECORDED_QUOTE_COLUMNS,
  RECORDED_QUOTE_VALUES,
  recordedQuoteValues,
} from "./token-movement-legs.repository";

/**
 * The expectation columns (migration 0175), one variant per asset: all null on
 * a request written before expectations, native SOL at 9 decimals with no
 * mint, or a token naming its mint and program.
 */
const expectationColumnsSchema = z.discriminatedUnion("asset_kind", [
  z.object({
    asset_kind: z.null(),
    mint: z.null(),
    token_program: z.null(),
    decimals: z.null(),
    expected_credit: z.null(),
  }),
  z.object({
    asset_kind: z.literal("native"),
    mint: z.null(),
    token_program: z.null(),
    decimals: z.literal(9),
    expected_credit: z.string(),
  }),
  z.object({
    asset_kind: z.literal("token"),
    mint: z.string(),
    token_program: z.enum(TOKEN_PROGRAM_KINDS),
    decimals: z.number().int(),
    expected_credit: z.string(),
  }),
]);

function parseExpectation(row: Record<string, unknown>): PaymentRequestExpectation | null {
  const columns = expectationColumnsSchema.parse(row);
  switch (columns.asset_kind) {
    case null:
      return null;
    case "native":
      return {
        asset: { kind: "native" },
        decimals: columns.decimals,
        credit: parseBaseUnits(columns.expected_credit),
      };
    case "token":
      return {
        asset: { kind: "token", mint: address(columns.mint), program: columns.token_program },
        decimals: columns.decimals,
        credit: parseBaseUnits(columns.expected_credit),
      };
    default: {
      const exhaustive: never = columns;
      throw new Error(`Unknown expectation columns: ${JSON.stringify(exhaustive)}`);
    }
  }
}

const issuedTransactionRowSchema = z.object({
  id: z.string(),
  payment_request_id: z.string(),
  organization_id: z.string(),
  project_id: z.string(),
  payer: z.string(),
  last_valid_block_height: z.string(),
  signature: z.string().nullable(),
  outcome: z.enum(PAYMENT_REQUEST_TRANSACTION_OUTCOMES),
  created_at: z.string(),
});

function mapIssuedTransaction(raw: Record<string, unknown>): PaymentRequestTransaction {
  const row = issuedTransactionRowSchema.parse(raw);
  if (row.signature !== null) {
    assertIsSignature(row.signature);
  }
  return {
    id: row.id,
    paymentRequestId: row.payment_request_id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    payer: row.payer,
    lastValidBlockHeight: BigInt(row.last_valid_block_height),
    signature: row.signature,
    quote: parseRecordedLegQuote(raw),
    outcome: row.outcome,
    createdAt: row.created_at,
  };
}

function signedIssuedTransaction(
  transaction: PaymentRequestTransaction
): SignedPaymentRequestTransaction {
  const { signature } = transaction;
  if (signature === null) {
    throw internalError("payment_request_transactions row read as signed has no signature");
  }
  return { ...transaction, signature };
}

function generatePaymentRequestTransactionId(): string {
  return `prtx_${crypto.randomUUID()}`;
}

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
    expectation: parseExpectation(row),
    reference: row.reference as string,
    status: row.status as PaymentRequestStatus,
    expires_at: row.expires_at as string | null,
    fulfilled_by_transfer_id: row.fulfilled_by_transfer_id as string | null,
    canceled_by: row.canceled_by as string | null,
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
  };
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
             asset_kind,
             mint,
             token_program,
             decimals,
             expected_credit,
             reference,
             expires_at,
             created_by,
             lifecycle
           ) VALUES (
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::numeric, ?, ?, ?,
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
          input.expectation.asset.kind,
          input.expectation.asset.kind === "token" ? input.expectation.asset.mint : null,
          input.expectation.asset.kind === "token" ? input.expectation.asset.program : null,
          input.expectation.decimals,
          input.expectation.credit.toString(),
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
                 canceled_by = ?,
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
          input.canceledBy,
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
      return db.transaction(async (tx) => {
        const claimed = await tx.queryOne<{ organization_id: string; project_id: string }>(
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
             -- A signed window still open can still land, even in its last
             -- blocks: a second window would let the payer pay twice. /pay
             -- closes one once the chain proves it failed or lapsed, and
             -- settlement closes the one that paid.
             AND NOT EXISTS (
               SELECT 1 FROM payment_request_transactions issued
                WHERE issued.payment_request_id = payment_requests.id
                  AND issued.outcome = 'open'
                  AND issued.signature IS NOT NULL
                  AND issued.status <> 'archived'
             )
           RETURNING organization_id, project_id`,
          [
            params.account,
            params.unsignedTransaction,
            params.lastValidBlockHeight.toString(),
            params.requestId,
            params.currentBlockHeight.toString(),
          ]
        );
        if (claimed === null) {
          return false;
        }
        await tx.execute(
          `INSERT INTO payment_request_transactions (
             id, payment_request_id, organization_id, project_id, payer, unsigned_transaction,
             last_valid_block_height, ${RECORDED_QUOTE_COLUMNS}
           ) VALUES (?, ?, ?, ?, ?, ?, ?::numeric, ${RECORDED_QUOTE_VALUES})`,
          [
            generatePaymentRequestTransactionId(),
            params.requestId,
            claimed.organization_id,
            claimed.project_id,
            params.account,
            params.unsignedTransaction,
            params.lastValidBlockHeight.toString(),
            ...recordedQuoteValues(params.quote),
          ]
        );
        return true;
      });
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
      const issued = await db.queryOne(
        `SELECT * FROM payment_request_transactions
          WHERE payment_request_id = ? AND unsigned_transaction = ? AND status <> 'archived'`,
        [requestId, row.sponsored_tx_unsigned]
      );
      return {
        account: row.sponsored_tx_account,
        unsignedTransaction: row.sponsored_tx_unsigned,
        signedTransaction: row.sponsored_tx_signed,
        lastValidBlockHeight: BigInt(row.sponsored_tx_last_valid_block_height),
        issued: issued === null ? null : mapIssuedTransaction(issued),
      };
    },

    async storeSponsoredTransactionSignature(params) {
      return db.transaction(async (tx) => {
        const changed = await tx.execute(
          `UPDATE payment_requests
             SET sponsored_tx_signed = ?, updated_at = sdp_iso_now()
           WHERE id = ?
             AND sponsored_tx_account = ?
             AND sponsored_tx_unsigned = ?
             AND sponsored_tx_signed IS NULL`,
          [params.signedTransaction, params.requestId, params.account, params.unsignedTransaction]
        );
        if (changed === 0) {
          return false;
        }
        const signed = await tx.execute(
          `UPDATE payment_request_transactions
             SET signature = ?, updated_at = sdp_iso_now()
           WHERE payment_request_id = ?
             AND unsigned_transaction = ?
             AND payer = ?
             AND signature IS NULL
             AND status <> 'archived'`,
          [params.signature, params.requestId, params.unsignedTransaction, params.account]
        );
        if (signed !== 1) {
          // A claim with no issued transaction (the previous revision's) is never signed here.
          throw internalError("The claimed payment request transaction has no issued record");
        }
        return true;
      });
    },

    async listOpenPaymentRequestTransactions(params) {
      const rows = await db.queryMany(
        `SELECT * FROM payment_request_transactions
          WHERE payment_request_id = ?
            AND organization_id = ?
            AND project_id = ?
            AND outcome = 'open'
            AND signature IS NOT NULL
            AND status <> 'archived'
          ORDER BY created_at, id`,
        [params.requestId, params.organizationId, params.projectId]
      );
      return rows.map((row) => signedIssuedTransaction(mapIssuedTransaction(row)));
    },

    async closePaymentRequestTransactions(params) {
      if (params.outcomes.length === 0) {
        return;
      }
      // One statement for every window, so a closing read settles all of them or none.
      await db.execute(
        `UPDATE payment_request_transactions issued
            SET outcome = closing.outcome,
                landed_slot = closing.landed_slot::numeric,
                updated_at = sdp_iso_now()
           FROM jsonb_to_recordset(?::jsonb) AS closing(signature text, outcome text, landed_slot text)
          WHERE issued.signature = closing.signature
            AND issued.payment_request_id = ?
            AND issued.organization_id = ?
            AND issued.project_id = ?
            AND issued.outcome = 'open'
            AND issued.status <> 'archived'`,
        [
          JSON.stringify(
            params.outcomes.map((entry) => ({
              signature: entry.signature,
              outcome: entry.outcome,
              landed_slot: entry.landedSlot === null ? null : entry.landedSlot.toString(),
            }))
          ),
          params.requestId,
          params.organizationId,
          params.projectId,
        ]
      );
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

    async listExpiredPaymentRequestsForLateCheck({
      environment,
      expiredSince,
      checkedBefore,
      limit,
    }) {
      const result = await db
        .prepare(
          `SELECT pr.* FROM payment_requests pr
             JOIN projects p ON p.id = pr.project_id
            WHERE p.environment = ?
              AND pr.status = 'expired'
              AND pr.custody_wallet_id IS NOT NULL
              AND pr.expires_at >= ?
              AND (pr.last_checked_at IS NULL OR pr.last_checked_at < ?)
            ORDER BY pr.last_checked_at ASC NULLS FIRST, pr.expires_at ASC, pr.id ASC
            LIMIT ?`
        )
        .bind(environment, expiredSince, checkedBefore, limit)
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

    async markExpiredPaymentRequestPaid(input: MarkExpiredPaymentRequestPaidInput) {
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
             AND status = 'expired'
           RETURNING *`
        )
        .bind(
          input.paidLate,
          input.fulfilledByTransferId,
          input.requestId,
          input.organizationId,
          input.projectId
        )
        .first<Record<string, unknown>>();
      return row ? mapPaymentRequestRow(row) : null;
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

    async countStaleLateWatchPaymentRequests({ environment, expiredSince, checkedBefore }) {
      const row = await db
        .prepare(
          `SELECT COUNT(*)::int AS stale FROM payment_requests pr
             JOIN projects p ON p.id = pr.project_id
            WHERE p.environment = ?
              AND pr.status = 'expired'
              AND pr.custody_wallet_id IS NOT NULL
              AND pr.expires_at >= ?
              AND pr.settlement_blocked_reason IS NULL
              AND COALESCE(pr.last_verified_at, pr.updated_at) < ?`
        )
        .bind(environment, expiredSince, checkedBefore)
        .first<{ stale: number }>();
      if (!row) {
        throw internalError("payment_requests late-watch stale COUNT returned no row");
      }
      return row.stale;
    },
  };
}
