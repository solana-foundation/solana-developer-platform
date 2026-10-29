import type { Context } from "hono";
import { getDb } from "@/db/client";
import type { PaymentRequestRow } from "@/db/repositories/payment-requests.repository";
import {
  createPaymentRequestsRepository,
  createTransactionalPaymentRequestsRepository,
} from "@/db/repositories/repository-factory";
import { conflict, internalError } from "@/lib/errors";
import { currentMandateActivator } from "@/lib/money-principal";
import { getRequestTenantScope } from "@/lib/tenant-scope";
import { logEvent } from "@/runtime/money-path-events";
import { AuditService } from "@/services/audit.service";
import { isPaymentRequestExpired, readLiveClaimFloor } from "@/services/payments/payment-requests";
import type { Env } from "@/types/env";

const LIVE_CLAIM_MESSAGE =
  "A payer holds a sponsored transaction for this payment request that can still land; retry once it expires";

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
 * Cancel an open payment request, so its `/pay` link stops building transactions. Compare-and-
 * set from `awaiting_payment`, with its audit record in the same transaction. A request that is
 * already canceled answers with its row before any chain read, so a retry needs no RPC.
 *
 * A request holding a sponsored transaction that can still land stays open: that transaction is
 * a bearer instrument until its blockhash expires. The live-claim floor is read once, only when
 * the row holds a claim. A lagging node reads a lower height, so the hold lasts longer: the safe
 * direction. A payment signed before the cancel and landed after it is recorded by the late
 * watch as paid.
 *
 * Who canceled is the key or member that authenticated the request, read from the ambient money
 * principal, so no caller can name another.
 *
 * @param c - The request context: its tenant scope, database identity and audit actor.
 * @param row - The request as read in the caller's Project; the compare-and-set decides.
 * @returns The canceled request.
 * @throws AppError `CONFLICT` when it is paid or expired, or a sponsored transaction can land.
 * @throws AppError `SOLANA_RPC_ERROR` when the row holds a claim and the cluster cannot be read.
 */
export async function cancelOpenPaymentRequest(
  c: Context<{ Bindings: Env }>,
  row: PaymentRequestRow
): Promise<PaymentRequestRow> {
  const canceledBy = currentMandateActivator();
  if (canceledBy === null) {
    throw internalError("A payment request cancel runs without an authenticated key or member");
  }
  if (cancelState(row) === "canceled") return row;
  const key = {
    requestId: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
  };
  const claimHeight = row.sponsored_tx_last_valid_block_height;
  const liveClaimFloor = claimHeight === null ? null : await readLiveClaimFloor();
  const scope = getRequestTenantScope(c);

  if (claimHeight !== null && (liveClaimFloor === null || claimHeight >= liveClaimFloor)) {
    throw conflict(LIVE_CLAIM_MESSAGE);
  }

  const canceled = await new AuditService(getDb(c.env)).logWithin(c, async (tx) => {
    const result = await createTransactionalPaymentRequestsRepository(
      tx,
      scope
    ).cancelPaymentRequest({
      ...key,
      canceledBy,
      liveClaimMinLastValidBlockHeight: liveClaimFloor,
    });
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
