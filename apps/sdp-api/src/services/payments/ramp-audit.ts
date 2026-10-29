import type { Context } from "hono";
import type { DatabaseClient } from "@/db/client";
import { getDb } from "@/db/client";
import type { PaymentsRepository, PaymentTransferRow } from "@/db/repositories/payments.repository";
import { createTransactionalPaymentsRepository } from "@/db/repositories/repository-factory";
import { getRequestTenantScope } from "@/lib/tenant-scope";
import {
  type AuditAction,
  AuditService,
  createSystemAuditService,
  type SystemAuditLogEntry,
} from "@/services/audit.service";
import type { Env } from "@/types/env";

/** The ramp steps the audit ledger records: a quote, a cancel, a settlement, a provider failure. */
export type RampAuditAction = Extract<AuditAction, "create" | "cancel" | "settle" | "update">;

/** The audit record of one ramp step. */
export function rampAuditEntry(
  action: RampAuditAction,
  transfer: PaymentTransferRow,
  extra: Record<string, unknown> = {}
): SystemAuditLogEntry {
  return {
    organizationId: transfer.organization_id,
    action,
    resourceType: "payment_transfer",
    resourceId: transfer.id,
    metadata: {
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
    },
  };
}

/**
 * A ramp step a request takes: its transfer write and audit row commit
 * together, or neither does. A write that changed nothing records nothing.
 */
export function auditedRampWrite(
  c: Context<{ Bindings: Env }>,
  action: RampAuditAction,
  write: (repository: PaymentsRepository) => Promise<PaymentTransferRow | null>,
  extra: Record<string, unknown> = {}
): Promise<PaymentTransferRow | null> {
  return new AuditService(getDb(c.env)).logWithin(c, async (tx: DatabaseClient) => {
    const written = await write(
      createTransactionalPaymentsRepository(tx, getRequestTenantScope(c))
    );
    return { entry: written ? rampAuditEntry(action, written, extra) : null, result: written };
  });
}

/**
 * `auditedRampWrite` for the delivery verifier, which has no request. The
 * caller builds its system repository on the transaction it is handed.
 */
export function auditedRampWriteSystem(
  env: Env,
  action: RampAuditAction,
  write: (tx: DatabaseClient) => Promise<PaymentTransferRow | null>,
  extra: Record<string, unknown> = {}
): Promise<PaymentTransferRow | null> {
  return createSystemAuditService(env).logSystemWithin(async (tx) => {
    const written = await write(tx);
    return { entry: written ? rampAuditEntry(action, written, extra) : null, result: written };
  });
}
