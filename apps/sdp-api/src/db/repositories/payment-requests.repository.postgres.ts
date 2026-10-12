import type { PaymentRequestLifecycleEvent, PaymentRequestStatus } from "@sdp/types";
import { z } from "zod";
import type { AppDb } from "@/db";
import { internalError } from "@/lib/errors";
import { parseNullableCustodyWalletId } from "./payment-execution-identity";
import type {
  CreatePaymentRequestInput,
  ListPaymentRequestsInput,
  ListPaymentRequestsResult,
  MarkPaymentRequestInput,
  PaymentRequestRow,
  PaymentRequestsRepository,
  SponsoredTransactionClaim,
} from "./payment-requests.repository";
import {
  generatePaymentRequestId,
  generatePaymentRequestPublicToken,
  generatePaymentRequestReference,
} from "./payment-requests.repository";

const sponsoredTransactionContinuitySchema = z
  .object({
    account: z.string().min(1),
    unsignedTransaction: z.string().min(1),
    lastValidBlockHeight: z.string().regex(/^\d+$/),
    deploymentMode: z.enum(["managed", "self_hosted"]),
    accountingIdentity: z
      .object({
        reservationId: z.string().min(1),
        attempt: z.number().int().positive(),
        network: z.enum(["devnet", "mainnet"]),
        environment: z.enum(["sandbox", "production"]),
        organizationId: z.string().min(1),
        projectId: z.string().min(1).nullable(),
        actor: z.object({
          type: z.enum(["api_key", "project", "user", "wallet"]),
          id: z.string().min(1),
        }),
        transactionDigest: z.string().regex(/^[a-f0-9]{64}$/),
        feePayer: z.string().min(1),
        providerConfigFingerprint: z.string().min(1),
      })
      .nullable(),
  })
  .refine(
    (continuity) =>
      continuity.deploymentMode === "managed" || continuity.accountingIdentity === null
  );

function claimContinuity(claim: SponsoredTransactionClaim | null): string | null {
  if (!claim?.deploymentMode) return null;
  return JSON.stringify({
    account: claim.account,
    unsignedTransaction: claim.unsignedTransaction,
    lastValidBlockHeight: claim.lastValidBlockHeight.toString(),
    deploymentMode: claim.deploymentMode,
    accountingIdentity: claim.accountingIdentity,
  });
}

function mapPaymentRequestRow(row: Record<string, unknown>): PaymentRequestRow {
  return {
    id: row.id as string,
    public_token: row.public_token as string,
    organization_id: row.organization_id as string,
    project_id: row.project_id as string | null,
    counterparty_id: row.counterparty_id as string | null,
    custody_wallet_id: parseNullableCustodyWalletId(row.custody_wallet_id),
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

// "expired" is computed from expires_at and never written to the status column,
// so it (and awaiting_payment) filter the awaiting_payment rows partitioned by
// expiry. Text comparison is exact: expires_at and sdp_iso_now() share the same
// ISO-8601 UTC format, and the partial index on (expires_at) covers the predicate.
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
        sql: "status = 'awaiting_payment' AND expires_at IS NOT NULL AND expires_at <= sdp_iso_now()",
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
             counterparty_id,
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
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             jsonb_build_array(jsonb_build_object('status', 'awaiting_payment', 'at', sdp_iso_now()))
           )
           RETURNING *`
        )
        .bind(
          id,
          publicToken,
          input.organizationId,
          input.projectId,
          input.counterpartyId,
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

    async claimSponsoredTransactionWindow(params) {
      const row = await db
        .prepare(
          `UPDATE payment_requests
             SET sponsored_tx_account = ?,
                 sponsored_tx_unsigned = ?,
                 sponsored_tx_signed = NULL,
                 sponsored_tx_last_valid_block_height = ?,
                 sponsored_tx_continuity = ?::jsonb,
                 updated_at = sdp_iso_now()
           WHERE id = ?
             AND status = 'awaiting_payment'
             AND (
               sponsored_tx_last_valid_block_height IS NULL
               OR sponsored_tx_last_valid_block_height < ?
             )
             AND (?::boolean OR (
               sponsored_tx_account IS NOT DISTINCT FROM ?::text
               AND sponsored_tx_unsigned IS NOT DISTINCT FROM ?::text
               AND sponsored_tx_signed IS NOT DISTINCT FROM ?::text
               AND sponsored_tx_last_valid_block_height IS NOT DISTINCT FROM ?::bigint
               AND sponsored_tx_continuity IS NOT DISTINCT FROM ?::jsonb
             ))
           RETURNING id`
        )
        .bind(
          params.account,
          params.unsignedTransaction,
          params.lastValidBlockHeight.toString(),
          params.deploymentMode
            ? claimContinuity({
                ...params,
                deploymentMode: params.deploymentMode,
                signedTransaction: null,
                accountingIdentity: null,
              })
            : null,
          params.requestId,
          params.currentBlockHeight.toString(),
          params.expectedClaim === undefined,
          params.expectedClaim?.account ?? null,
          params.expectedClaim?.unsignedTransaction ?? null,
          params.expectedClaim?.signedTransaction ?? null,
          params.expectedClaim?.lastValidBlockHeight.toString() ?? null,
          claimContinuity(params.expectedClaim ?? null)
        )
        .first<{ id: string }>();
      return row !== null;
    },

    async getSponsoredTransactionClaim(requestId) {
      const row = await db
        .prepare(
          `SELECT sponsored_tx_account, sponsored_tx_unsigned, sponsored_tx_signed,
                  sponsored_tx_last_valid_block_height, sponsored_tx_continuity
             FROM payment_requests
            WHERE id = ?`
        )
        .bind(requestId)
        .first<{
          sponsored_tx_account: string | null;
          sponsored_tx_unsigned: string | null;
          sponsored_tx_signed: string | null;
          sponsored_tx_last_valid_block_height: string | number | null;
          sponsored_tx_continuity: unknown;
        }>();
      if (!row || row.sponsored_tx_account === null) {
        return null;
      }
      if (row.sponsored_tx_unsigned === null || row.sponsored_tx_last_valid_block_height === null) {
        throw internalError("payment_requests sponsored claim row is missing claim fields");
      }
      const continuity =
        row.sponsored_tx_continuity === null
          ? null
          : sponsoredTransactionContinuitySchema.safeParse(row.sponsored_tx_continuity);
      if (
        continuity &&
        (!continuity.success ||
          continuity.data.account !== row.sponsored_tx_account ||
          continuity.data.unsignedTransaction !== row.sponsored_tx_unsigned ||
          BigInt(continuity.data.lastValidBlockHeight) !==
            BigInt(row.sponsored_tx_last_valid_block_height))
      ) {
        throw internalError(
          "payment_requests sponsored continuity does not match the claimed window"
        );
      }
      return {
        account: row.sponsored_tx_account,
        unsignedTransaction: row.sponsored_tx_unsigned,
        signedTransaction: row.sponsored_tx_signed,
        lastValidBlockHeight: BigInt(row.sponsored_tx_last_valid_block_height),
        deploymentMode: continuity?.success ? continuity.data.deploymentMode : null,
        accountingIdentity: continuity?.success ? continuity.data.accountingIdentity : null,
      };
    },

    async persistSponsoredTransactionAccountingIdentity(params) {
      const continuity = claimContinuity({
        ...params,
        signedTransaction: null,
        deploymentMode: "managed",
        accountingIdentity: params.identity,
      });
      const emptyContinuity = claimContinuity({
        ...params,
        signedTransaction: null,
        deploymentMode: "managed",
        accountingIdentity: null,
      });
      const changed = await db
        .prepare(
          `UPDATE payment_requests SET sponsored_tx_continuity = ?::jsonb, updated_at = sdp_iso_now()
           WHERE id = ? AND organization_id = ? AND project_id IS NOT DISTINCT FROM ?
             AND status = 'awaiting_payment'
             AND sponsored_tx_account = ? AND sponsored_tx_unsigned = ?
             AND sponsored_tx_last_valid_block_height = ?
             AND (sponsored_tx_continuity IS NULL OR sponsored_tx_continuity = ?::jsonb
                  OR sponsored_tx_continuity = ?::jsonb
                  OR (
                    sponsored_tx_continuity - 'accountingIdentity' = ?::jsonb - 'accountingIdentity'
                    AND (sponsored_tx_continuity -> 'accountingIdentity') - 'attempt' = ?::jsonb - 'attempt'
                    AND (sponsored_tx_continuity #>> '{accountingIdentity,attempt}')::integer = ?
                  ))`
        )
        .bind(
          continuity,
          params.requestId,
          params.identity.organizationId,
          params.identity.projectId,
          params.account,
          params.unsignedTransaction,
          params.lastValidBlockHeight.toString(),
          emptyContinuity,
          continuity,
          continuity,
          JSON.stringify(params.identity),
          params.identity.attempt - 1
        )
        .run();
      return changed > 0;
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
  };
}
