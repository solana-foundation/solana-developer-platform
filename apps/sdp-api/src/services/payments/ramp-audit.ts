import type { Context } from "hono";
import { getDb } from "@/db/client";
import type { PaymentTransferRow } from "@/db/repositories/payments.repository";
import { createAuditLedgerCheckpointStore } from "@/runtime/kv-redis";
import { getLogger } from "@/runtime/logger";
import { type AuditAction, AuditService } from "@/services/audit.service";
import { AUDIT_LEDGER_REDIS_TIMEOUT_MS } from "@/services/audit-ledger-timeout";
import type { Env } from "@/types/env";

/** The ramp steps the audit ledger records: a quote, a cancel, a settlement, a provider failure. */
type RampAuditAction = Extract<AuditAction, "create" | "cancel" | "settle" | "update">;

function rampAuditMetadata(
  transfer: PaymentTransferRow,
  extra: Record<string, unknown>
): Record<string, unknown> {
  return {
    type: transfer.type,
    provider: transfer.provider,
    status: transfer.status,
    // Named tokenMint: the audit redaction policy scrubs a bare "token" key.
    tokenMint: transfer.token,
    amount: transfer.amount,
    fiatCurrency: transfer.fiat_currency,
    fiatAmount: transfer.fiat_amount,
    counterpartyId: transfer.counterparty_id,
    custodyWalletId: transfer.custody_wallet_id,
    providerReference: transfer.provider_reference,
    ...extra,
  };
}

function logAuditFailure(transfer: PaymentTransferRow, action: RampAuditAction, error: unknown) {
  getLogger().error(
    { event: "sdp_api_ramp_audit_write_failed", transfer_id: transfer.id, action, error },
    "ramp audit write failed; the transfer row stays the record"
  );
}

/**
 * Records a ramp step a request took. Best-effort and after the write: no
 * money moves at these steps, and the transfer row stays the record.
 */
export async function auditRampTransfer(
  c: Context<{ Bindings: Env }>,
  action: RampAuditAction,
  transfer: PaymentTransferRow,
  extra: Record<string, unknown> = {}
): Promise<void> {
  try {
    await new AuditService(getDb(c.env)).log(c, {
      organizationId: transfer.organization_id,
      action,
      resourceType: "payment_transfer",
      resourceId: transfer.id,
      metadata: rampAuditMetadata(transfer, extra),
    });
  } catch (error) {
    logAuditFailure(transfer, action, error);
  }
}

/** Records a ramp step a provider event or the delivery verifier took, best-effort. */
export async function auditRampTransferSystem(
  env: Env,
  action: RampAuditAction,
  transfer: PaymentTransferRow,
  extra: Record<string, unknown> = {}
): Promise<void> {
  try {
    await new AuditService(
      getDb(env),
      createAuditLedgerCheckpointStore(env, AUDIT_LEDGER_REDIS_TIMEOUT_MS)
    ).logSystem({
      organizationId: transfer.organization_id,
      action,
      resourceType: "payment_transfer",
      resourceId: transfer.id,
      metadata: rampAuditMetadata(transfer, extra),
    });
  } catch (error) {
    logAuditFailure(transfer, action, error);
  }
}
