import type { TokenTransaction } from "@sdp/types";
import { getLogger } from "@/runtime/logger";
import type { AuditAction, AuditService } from "@/services/audit.service";
import type { TokenService } from "@/services/token.service";

export interface SettledTransactionEvidence {
  signature: string;
  slot: number;
}

export function parseSettledTransactionEvidence(
  metadata: Record<string, unknown>
): SettledTransactionEvidence | null {
  const slot =
    typeof metadata.slot === "string" && /^\d+$/.test(metadata.slot)
      ? Number(metadata.slot)
      : metadata.slot;
  if (
    typeof metadata.signature !== "string" ||
    metadata.signature.length === 0 ||
    !Number.isSafeInteger(slot) ||
    Number(slot) < 0
  ) {
    return null;
  }
  return { signature: metadata.signature, slot: Number(slot) };
}

export async function persistSettledTransaction(
  tokenService: TokenService,
  transaction: TokenTransaction,
  evidence: SettledTransactionEvidence,
  params?: Record<string, unknown>
): Promise<TokenTransaction> {
  const settledParams = params ? { ...transaction.params, ...params } : transaction.params;
  try {
    return await tokenService.updateTransaction(transaction.id, {
      status: "confirmed",
      signature: evidence.signature,
      slot: evidence.slot,
      ...(params ? { params: settledParams } : {}),
    });
  } catch (error) {
    getLogger().error(
      {
        event: "settled_issuance_transaction_persistence_failed",
        transactionId: transaction.id,
        transactionType: transaction.type,
        signature: evidence.signature,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      "Settled issuance operation could not update its transaction row; durable audit evidence will repair idempotent replay"
    );
    return {
      ...transaction,
      status: "confirmed",
      signature: evidence.signature,
      slot: evidence.slot,
      error: null,
      params: settledParams,
      updatedAt: new Date().toISOString(),
    };
  }
}

export async function recoverSettledTransactionReplay(options: {
  auditService: AuditService;
  tokenService: TokenService;
  transaction: TokenTransaction;
  action: AuditAction;
  params?: Record<string, unknown>;
}): Promise<TokenTransaction> {
  if (options.transaction.status !== "pending") return options.transaction;
  const outcome = await options.auditService.findCriticalOutcome({
    organizationId: options.transaction.organizationId,
    action: options.action,
    resourceType: "token_transaction",
    resourceId: options.transaction.id,
  });
  if (outcome?.status !== "success") return options.transaction;
  const evidence = parseSettledTransactionEvidence(outcome.metadata);
  return evidence
    ? persistSettledTransaction(options.tokenService, options.transaction, evidence, options.params)
    : options.transaction;
}
