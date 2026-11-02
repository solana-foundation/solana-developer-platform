import { supportsProviderOrderCancellation } from "@sdp/earn/capabilities";
import { createClusterRpc } from "@sdp/rpc/factory";
import { currentClusterScope } from "@sdp/rpc/scope";
import {
  getChainHeight,
  getSignatureStatuses,
  getTransaction,
  reReadExpiredStatuses,
  type SignatureStatusInfo,
  type SolanaRpc,
  sendTransaction,
} from "@sdp/rpc/solana";
import { compareDecimalAmounts } from "@sdp/solana/amount";
import { isEarnProviderActionChainStatus } from "@sdp/types/earn-provider-orders";
import { signature } from "@solana/kit";
import { asTransactionalClient, getDb } from "@/db/client";
import { createPostgresEarnMovementsRepository } from "@/db/repositories/earn-movements.repository";
import {
  createEarnProviderActionsRepository,
  type EarnProviderActionRow,
} from "@/db/repositories/earn-provider-actions.repository";
import { getLogger } from "@/runtime/logger";
import type { Env } from "@/types/env";
import { resolveEarnExecutionClient } from "./execution-registry";
import { verifyProviderDelivery } from "./provider-settlement.service";
import { earnRuntime } from "./runtime";
import { createVaultDeadline } from "./vault-deadline";

export async function reconcileEarnProviderActions(env: Env): Promise<void> {
  const db = getDb(env),
    repo = createEarnProviderActionsRepository(db);
  const { environment } = currentClusterScope();
  const failures: Error[] = [];
  for (let count = 0; count < 128; count++) {
    const row = await repo.claimDue(environment);
    if (row === null) break;
    try {
      if (isEarnProviderActionChainStatus(row.status)) {
        await reconcileProviderActionSource(env, row);
        continue;
      }
      await settleCancellation(env, row);
    } catch (cause) {
      getLogger().error(
        {
          actionId: row.id,
          provider: row.provider,
          event: "earn_provider_action_reconciliation_failed",
        },
        "Provider action remains open for reconciliation"
      );
      failures.push(new Error(`Provider action ${row.id} could not be reconciled`, { cause }));
    }
  }
  if (failures.length > 0)
    throw new AggregateError(failures, "Earn provider action reconciliation failed");
}

async function settleCancellation(runtimeEnv: Env, row: EarnProviderActionRow) {
  const db = getDb(runtimeEnv),
    repo = createEarnProviderActionsRepository(db),
    ledger = createPostgresEarnMovementsRepository(db);
  const scope = {
    organizationId: row.organization_id,
    projectId: row.project_id,
    actionId: row.id,
  };
  if (row.action !== "cancellation" || !row.parent_movement_id || !row.signature)
    throw new Error("Invalid pending provider cancellation");
  const parent = await ledger.getMovementById({
    organizationId: row.organization_id,
    movementId: row.parent_movement_id,
  });
  if (!parent?.signature || !parent.signed_transaction || !parent.vault_address)
    throw new Error("Cancellation parent is unavailable");
  if (parent.status === "finalized") {
    await repo.advance(scope, "awaiting_delivery", "failed", {
      error: "The original redemption settled before cancellation",
    });
    return;
  }
  const client = resolveEarnExecutionClient(runtimeEnv, row.provider, createVaultDeadline());
  if (!client || !supportsProviderOrderCancellation(client))
    throw new Error("Cancellation observer is unavailable");
  const candidate = await client.readProviderOrderCancellation(earnRuntime(runtimeEnv), {
    providerReference: row.vault_address,
    owner: row.owner_address,
    sourceSignature: row.signature,
    sourceTransaction: parent.signed_transaction,
  });
  if (candidate.destinationSignature === null) return;
  const tx = await getTransaction(
    createClusterRpc(),
    signature(candidate.destinationSignature),
    "finalized"
  );
  if (tx === null) return;
  const position = await ledger.getPositionById({
    organizationId: row.organization_id,
    environment: row.environment,
    positionId: parent.position_id,
  });
  if (!position) throw new Error("Cancellation position is unavailable");
  const receipt = verifyProviderDelivery(
    {
      ...parent,
      direction: "deposit",
      source_address: row.owner_address,
      signature: row.signature,
    },
    position,
    candidate,
    tx
  );
  // A partial return is not proof that the entire original request was cancelled.
  // Keep the obligation open for recovery rather than inventing a payout or losing the remainder.
  if (receipt === null || compareDecimalAmounts(receipt.amount, parent.amount_requested) !== 0)
    return;
  const parentSignature = parent.signature;
  await db.transaction(async (executor) => {
    const transaction = asTransactionalClient(executor),
      actions = createEarnProviderActionsRepository(transaction);
    const closed = await actions.advance(scope, "awaiting_delivery", "finalized", {
      delivery_signature: receipt.destinationSignature,
    });
    if (closed === null) return;
    const observedAt = new Date().toISOString();
    const recorded = await createPostgresEarnMovementsRepository(transaction).advanceVaultMovement({
      movementId: parent.id,
      organizationId: parent.organization_id,
      toStatus: "finalized",
      confirmedAt: observedAt,
      settledAt: observedAt,
      tokenAmountSettled: "0",
      providerSettlement: { ...receipt, outcome: "cancelled", sourceSignature: parentSignature },
    });
    if (recorded === null) throw new Error("Original redemption advanced during cancellation");
  });
}

async function reconcileProviderActionSource(env: Env, row: EarnProviderActionRow): Promise<void> {
  const repo = createEarnProviderActionsRepository(getDb(env));
  const scope = {
    organizationId: row.organization_id,
    projectId: row.project_id,
    actionId: row.id,
  };
  if (!row.signature || !row.signed_transaction || !row.last_valid_block_height)
    throw new Error("Provider action outbox is incomplete");
  const rpc = createClusterRpc({ timeoutMs: 5_000 });

  const [observed] = await getSignatureStatuses(rpc, [signature(row.signature)], {
    searchTransactionHistory: true,
  });
  const status = observed ?? null;
  if (await judgeSourceStatus(repo, scope, row, status)) return;
  if (row.status === "confirmed") return; // Missing history cannot disprove a landed transaction.
  const height = await getChainHeight(rpc, "finalized");
  if (height.blockHeight <= BigInt(row.last_valid_block_height)) {
    if (status === null) await rebroadcastSourceAction(rpc, row.id, row.signed_transaction);
    return;
  }
  await expireProviderActionSource(repo, scope, row, rpc, height, row.signature, status);
}

/**
 * One chain observation's verdict for an action's source transaction — shared
 * by the live status read and the expiry re-reads, so a re-read that finds the
 * landed transaction judges it exactly like a first observation would. Returns
 * false when the observation does not yet decide the action.
 */
async function judgeSourceStatus(
  repo: ReturnType<typeof createEarnProviderActionsRepository>,
  scope: { organizationId: string; projectId: string; actionId: string },
  row: EarnProviderActionRow,
  status: SignatureStatusInfo | null
): Promise<boolean> {
  if (status?.err && status.confirmationStatus === "finalized") {
    await repo.advance(scope, row.status, "failed", {
      error: "Source transaction failed on chain",
    });
    return true;
  }
  if (status?.confirmationStatus === "finalized") {
    await repo.advance(
      scope,
      row.status,
      row.action === "preparation" ? "finalized" : "awaiting_delivery"
    );
    return true;
  }
  if (status?.confirmationStatus === "confirmed") {
    if (row.status !== "confirmed") await repo.advance(scope, row.status, "confirmed");
    return true;
  }
  return false;
}

async function rebroadcastSourceAction(
  rpc: SolanaRpc,
  actionId: string,
  signedTransaction: string
): Promise<void> {
  try {
    await sendTransaction(rpc, Uint8Array.from(Buffer.from(signedTransaction, "base64")));
  } catch (cause) {
    getLogger().warn(
      { actionId, errorName: cause instanceof Error ? cause.name : "unknown" },
      "Provider action rebroadcast outcome remains unknown"
    );
  }
}

/**
 * The finalized height proves the blockhash expired while the status read
 * stayed silent. A null status alone never proves a transaction absent: the
 * pool endpoint answering statuses can lag the node that answered the height.
 * Re-read the signature at the height's slot (`minContextSlot`), then consult
 * finalized transaction history, before closing the intent — a landed
 * cancellation recorded as failed would permit filing another one. A re-read
 * or history outage throws and leaves the action recoverable.
 */
async function expireProviderActionSource(
  repo: ReturnType<typeof createEarnProviderActionsRepository>,
  scope: { organizationId: string; projectId: string; actionId: string },
  row: EarnProviderActionRow,
  rpc: SolanaRpc,
  height: Awaited<ReturnType<typeof getChainHeight>>,
  signatureText: string,
  status: SignatureStatusInfo | null
): Promise<void> {
  if (status === null) {
    const [reRead] = await reReadExpiredStatuses(
      rpc,
      [null],
      [{ index: 0, signature: signature(signatureText) }],
      height.absoluteSlot
    );
    if (await judgeSourceStatus(repo, scope, row, reRead ?? null)) return;
    const transaction = await getTransaction(rpc, signature(signatureText), "finalized");
    if (transaction !== null) {
      if (!transaction.executionResultKnown)
        throw new Error(`Provider action ${row.id} has no historical execution result`);
      if (transaction.err === null) {
        await repo.advance(
          scope,
          row.status,
          row.action === "preparation" ? "finalized" : "awaiting_delivery"
        );
      } else {
        await repo.advance(scope, row.status, "failed", {
          error: "Source transaction failed on chain",
        });
      }
      return;
    }
  }
  // Two history-aware observations on separate due ticks, after finalized expiry.
  if (row.unknown_signature_observed_at === null)
    await repo.observeUnknownSignature(scope, row.status);
  else if (Date.parse(row.unknown_signature_observed_at) < Date.now() - 60_000)
    await repo.advance(scope, row.status, "failed", {
      error: "Source transaction expired without a confirmed signature",
    });
}
