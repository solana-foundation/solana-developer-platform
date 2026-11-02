import { supportsProviderOrderCancellation } from "@sdp/earn/capabilities";
import { createClusterRpc } from "@sdp/rpc/factory";
import { currentClusterScope } from "@sdp/rpc/scope";
import { getSignatureStatuses, getTransaction, sendTransaction } from "@sdp/rpc/solana";
import { compareDecimalAmounts } from "@sdp/solana/amount";
import { EARN_PROVIDER_ACTION_CHAIN_STATUSES } from "@sdp/types/earn-provider-orders";
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
      if ((EARN_PROVIDER_ACTION_CHAIN_STATUSES as readonly string[]).includes(row.status)) {
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

  const [status] = await getSignatureStatuses(rpc, [signature(row.signature)], {
    searchTransactionHistory: true,
  });
  if (status?.err && status.confirmationStatus === "finalized") {
    await repo.advance(scope, row.status, "failed", {
      error: "Source transaction failed on chain",
    });
    return;
  }
  if (status?.confirmationStatus === "finalized") {
    await repo.advance(
      scope,
      row.status,
      row.action === "preparation" ? "finalized" : "awaiting_delivery"
    );
    return;
  }
  if (status?.confirmationStatus === "confirmed") {
    if (row.status !== "confirmed") await repo.advance(scope, row.status, "confirmed");
    return;
  }
  if (row.status === "confirmed") return; // Missing history cannot disprove a landed transaction.
  const height = await rpc.getBlockHeight({ commitment: "finalized" }).send();
  if (height > BigInt(row.last_valid_block_height)) {
    // Two history-aware observations on separate due ticks, after finalized expiry.
    if (row.unknown_signature_observed_at === null)
      await repo.observeUnknownSignature(scope, row.status);
    else if (Date.parse(row.unknown_signature_observed_at) < Date.now() - 60_000)
      await repo.advance(scope, row.status, "failed", {
        error: "Source transaction expired without a confirmed signature",
      });
  } else if (status == null) {
    try {
      await sendTransaction(rpc, Uint8Array.from(Buffer.from(row.signed_transaction, "base64")));
    } catch (cause) {
      getLogger().warn(
        { actionId: row.id, errorName: cause instanceof Error ? cause.name : "unknown" },
        "Provider action rebroadcast outcome remains unknown"
      );
    }
  }
}
