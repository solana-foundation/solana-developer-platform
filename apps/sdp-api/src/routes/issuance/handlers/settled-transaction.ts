import type { TokenTransaction } from "@sdp/types";
import { getLogger } from "@/runtime/logger";
import {
  type AuditAction,
  AuditPersistenceError,
  type AuditService,
} from "@/services/audit.service";
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

async function persistSettledTransactionWithDurability(
  tokenService: TokenService,
  transaction: TokenTransaction,
  evidence: SettledTransactionEvidence,
  params?: Record<string, unknown>
): Promise<{ transaction: TokenTransaction; durable: boolean }> {
  const settledParams = params ? { ...transaction.params, ...params } : transaction.params;
  try {
    return {
      transaction: await tokenService.updateTransaction(transaction.id, {
        status: "confirmed",
        signature: evidence.signature,
        slot: evidence.slot,
        ...(params ? { params: settledParams } : {}),
      }),
      durable: true,
    };
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

    // Preserve the chain receipt independently of the status transition. A
    // retry can recover directly from these columns even when the terminal
    // audit append also misses. This second, narrower write also avoids losing
    // evidence when only status-history bookkeeping caused the first write to
    // reject after the transaction row itself changed.
    let durable = false;
    try {
      await tokenService.updateTransaction(transaction.id, {
        signature: evidence.signature,
        slot: evidence.slot,
        ...(params ? { params: settledParams } : {}),
      });
      durable = true;
    } catch (evidenceError) {
      getLogger().error(
        {
          event: "settled_issuance_evidence_persistence_failed",
          transactionId: transaction.id,
          signature: evidence.signature,
          error: evidenceError instanceof Error ? evidenceError.message : "Unknown evidence error",
        },
        "Settled issuance evidence could not be journaled; terminal audit persistence remains the recovery fallback"
      );
    }
    return {
      transaction: {
        ...transaction,
        status: "confirmed",
        signature: evidence.signature,
        slot: evidence.slot,
        error: null,
        params: settledParams,
        updatedAt: new Date().toISOString(),
      },
      durable,
    };
  }
}

export async function persistSettledTransaction(
  tokenService: TokenService,
  transaction: TokenTransaction,
  evidence: SettledTransactionEvidence,
  params?: Record<string, unknown>
): Promise<TokenTransaction> {
  return (
    await persistSettledTransactionWithDurability(tokenService, transaction, evidence, params)
  ).transaction;
}

/**
 * Record settlement in the operational transaction row before appending the
 * audit outcome. The two writes are deliberately independent: a failed audit
 * append cannot strand a completed operation as pending, while a failed
 * transaction write still falls back to the immutable audit outcome used by
 * replay recovery.
 */
export async function persistSettledTransactionThenOutcome(options: {
  tokenService: TokenService;
  transaction: TokenTransaction;
  evidence: SettledTransactionEvidence;
  params?: Record<string, unknown>;
  persistOutcome: () => Promise<boolean>;
}): Promise<TokenTransaction> {
  const settled = await persistSettledTransactionWithDurability(
    options.tokenService,
    options.transaction,
    options.evidence,
    options.params
  );
  const outcomePersisted = await options.persistOutcome();
  if (!settled.durable && !outcomePersisted) {
    throw new AuditPersistenceError({
      cause: new Error("Settled issuance operation has no durable recovery evidence"),
    });
  }
  return settled.transaction;
}

export async function recoverSettledTransactionReplay(options: {
  auditService: AuditService;
  tokenService: TokenService;
  transaction: TokenTransaction;
  action: AuditAction;
  params?: Record<string, unknown>;
}): Promise<TokenTransaction> {
  if (options.transaction.status !== "pending") return options.transaction;
  const journaledEvidence = parseSettledTransactionEvidence({
    signature: options.transaction.signature,
    slot: options.transaction.slot,
  });
  if (journaledEvidence) {
    return persistSettledTransaction(
      options.tokenService,
      options.transaction,
      journaledEvidence,
      options.params
    );
  }
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
