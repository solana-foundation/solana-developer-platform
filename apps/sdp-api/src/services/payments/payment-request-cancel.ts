import { SdpRpcError } from "@sdp/rpc/errors";
import { createClusterRpc } from "@sdp/rpc/factory";
import { isSolanaError } from "@solana/kit";
import type { Context } from "hono";
import { getDb } from "@/db/client";
import type { PaymentRequestRow } from "@/db/repositories/payment-requests.repository";
import {
  createPaymentRequestsRepository,
  createTransactionalPaymentRequestsRepository,
} from "@/db/repositories/repository-factory";
import { resolveCreatorUserId } from "@/lib/creator";
import { conflict, internalError, solanaRpcError } from "@/lib/errors";
import { getRequestTenantScope } from "@/lib/tenant-scope";
import { logEvent } from "@/runtime/money-path-events";
import { AuditService } from "@/services/audit.service";
import {
  isPaymentRequestExpired,
  SPONSORED_CLAIM_BLOCK_MARGIN,
} from "@/services/payments/payment-requests";
import type { Env } from "@/types/env";

const LIVE_CLAIM_MESSAGE =
  "A payer holds a sponsored transaction for this payment request that can still land; retry once it expires";

export interface CancelCreatedByKeyResult {
  canceled: string[];
  failed: string[];
}

/**
 * Whether a request can still be canceled. A canceled one answers as it is; a paid or expired
 * one, including an open one past its `expires_at`, refuses.
 *
 * @param row - The request as last read.
 * @returns `canceled` when it already is, `open` when a cancel may proceed.
 * @throws AppError `CONFLICT` when the request is paid or expired.
 */
function cancelState(row: PaymentRequestRow): "canceled" | "open" {
  switch (row.status) {
    case "canceled":
      return "canceled";
    case "paid":
      throw conflict("Payment request is already paid");
    case "expired":
      throw conflict("Payment request has expired");
    case "awaiting_payment":
      if (isPaymentRequestExpired(row.expires_at)) {
        throw conflict("Payment request has expired");
      }
      return "open";
    default: {
      const unreachable: never = row.status;
      throw internalError(`Unhandled payment request status ${String(unreachable)}`);
    }
  }
}

/**
 * The lowest last valid block height a sponsored transaction may hold and still land, read as
 * the expiry lane reads it: confirmed height less the hot-lane margin.
 *
 * @returns The height below which a claim can no longer land.
 * @throws AppError `SOLANA_RPC_ERROR` when the cluster cannot be read; the cancel never proceeds
 *   without the check.
 */
async function readLiveClaimMinLastValidBlockHeight(): Promise<bigint> {
  let blockHeight: bigint;
  try {
    blockHeight = await createClusterRpc().getBlockHeight({ commitment: "confirmed" }).send();
  } catch (error) {
    if (error instanceof SdpRpcError || !isSolanaError(error)) throw error;
    throw solanaRpcError("Could not read the cluster's block height; retry the cancel");
  }
  return blockHeight - SPONSORED_CLAIM_BLOCK_MARGIN;
}

/**
 * Cancel an open payment request, so its `/pay` link stops building transactions. Compare-and-
 * set from `awaiting_payment`, with its audit record in the same transaction. A request that is
 * already canceled answers with its row.
 *
 * A request holding a sponsored transaction that can still land stays open: that transaction is
 * a bearer instrument until its blockhash expires. Only then is the cluster read, once, for its
 * confirmed height. A lagging node reads a lower height, so the hold lasts longer: the safe
 * direction. A payment signed before the cancel and landed after it is recorded by the late
 * watch as paid.
 *
 * @param c - The request context: its tenant scope, database identity and audit actor.
 * @param params - The request to cancel and who cancels it.
 * @param params.row - The request as read in the caller's Project; the compare-and-set decides.
 * @param params.canceledBy - The acting principal, in the identifier format `created_by` uses.
 * @returns The canceled request.
 * @throws AppError `CONFLICT` when it is paid or expired, or a sponsored transaction can land.
 * @throws AppError `SOLANA_RPC_ERROR` when the block height cannot be read.
 */
export async function cancelOpenPaymentRequest(
  c: Context<{ Bindings: Env }>,
  params: { row: PaymentRequestRow; canceledBy: string }
): Promise<PaymentRequestRow> {
  const { row, canceledBy } = params;
  if (cancelState(row) === "canceled") return row;
  const key = {
    requestId: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
  };
  const scope = getRequestTenantScope(c);

  let liveClaimMinLastValidBlockHeight: bigint | null = null;
  if (row.sponsored_tx_last_valid_block_height !== null) {
    liveClaimMinLastValidBlockHeight = await readLiveClaimMinLastValidBlockHeight();
    if (row.sponsored_tx_last_valid_block_height >= liveClaimMinLastValidBlockHeight) {
      throw conflict(LIVE_CLAIM_MESSAGE);
    }
  }

  const canceled = await new AuditService(getDb(c.env)).logWithin(c, async (tx) => {
    const result = await createTransactionalPaymentRequestsRepository(
      tx,
      scope
    ).cancelPaymentRequest({ ...key, canceledBy, liveClaimMinLastValidBlockHeight });
    return {
      entry:
        result === null
          ? null
          : {
              organizationId: result.organization_id,
              action: "cancel" as const,
              resourceType: "payment_request" as const,
              resourceId: result.id,
              metadata: {
                projectId: result.project_id,
                fromStatus: "awaiting_payment",
                amount: result.amount,
                tokenMint: result.token,
                destination: result.destination_address,
                walletId: result.wallet_id,
              },
            },
      result,
    };
  });
  if (canceled) {
    logEvent("info", {
      event: "payment_requests.canceled",
      payment_request_id: canceled.id,
      organization_id: canceled.organization_id,
      project_id: canceled.project_id,
    });
    return canceled;
  }

  const current = await createPaymentRequestsRepository(c.env, scope).getPaymentRequestById(key);
  if (!current) throw internalError("payment request not found after cancel");
  if (cancelState(current) === "canceled") return current;
  // Still open and unexpired after a lost compare-and-set: a payer claimed a sponsored window.
  throw conflict(LIVE_CLAIM_MESSAGE);
}

/**
 * The compromised-key path for payment requests: cancel every open request a key created,
 * under its own id or one it was rotated from. Revoking a key never does this on its own, since
 * a request is an invoice that pays the merchant; a person asks for it on revoke. Each runs on
 * its own: one that fails, a request with a live sponsored transaction above all, is reported
 * and leaves the others canceled.
 *
 * @param c - The revoke request's context, under the key's Project.
 * @param scope - The revoked key and the Project it belongs to.
 * @param scope.organizationId - The key's Organization.
 * @param scope.projectId - The key's Project.
 * @param scope.apiKeyId - The revoked key.
 * @returns The ids canceled and the ids that could not be.
 */
export async function cancelPaymentRequestsCreatedByKey(
  c: Context<{ Bindings: Env }>,
  scope: { organizationId: string; projectId: string; apiKeyId: string }
): Promise<CancelCreatedByKeyResult> {
  const rows = await createPaymentRequestsRepository(
    c.env,
    getRequestTenantScope(c)
  ).listOpenPaymentRequestsCreatedByApiKey(scope);
  const canceledBy = await resolveCreatorUserId(c);
  const result: CancelCreatedByKeyResult = { canceled: [], failed: [] };
  for (const paymentRequest of rows) {
    try {
      await cancelOpenPaymentRequest(c, { row: paymentRequest, canceledBy });
      result.canceled.push(paymentRequest.id);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      logEvent("error", {
        event: "payment_requests.cancel_on_revoke_failed",
        organization_id: scope.organizationId,
        project_id: scope.projectId,
        api_key_id: scope.apiKeyId,
        payment_request_id: paymentRequest.id,
        error: error.message,
      });
      result.failed.push(paymentRequest.id);
    }
  }
  return result;
}
