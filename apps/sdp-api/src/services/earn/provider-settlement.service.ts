import { supportsProviderSettlement } from "@sdp/earn/capabilities";
import type { EarnProviderSettlementProvider } from "@sdp/earn/types";
import { createClusterRpc } from "@sdp/rpc/factory";
import { currentClusterScope } from "@sdp/rpc/scope";
import { getTransaction, type ParsedTransaction, tokenBalanceDelta } from "@sdp/rpc/solana";
import { formatDecimalAmount } from "@sdp/solana/amount";
import type { EarnProviderSettlement } from "@sdp/types/earn-provider-orders";
import { EARN_PROVIDERS } from "@sdp/types/provider-access";
import { signature } from "@solana/kit";
import { getDb } from "@/db/client";
import {
  createPostgresEarnMovementsRepository,
  type EarnMovementRow,
  type EarnPositionRow,
} from "@/db/repositories/earn-movements.repository";
import { getLogger } from "@/runtime/logger";
import type { Env } from "@/types/env";
import { resolveEarnExecutionClient } from "./execution-registry";
import { earnRuntime } from "./runtime";
import { createVaultDeadline } from "./vault-deadline";

type Candidate = Awaited<ReturnType<EarnProviderSettlementProvider["readProviderSettlement"]>>;

/** Provider correlation is necessary; an unrelated wallet balance change never settles an order. */
export function verifyProviderDelivery(
  movement: EarnMovementRow,
  position: EarnPositionRow,
  candidate: Candidate,
  tx: ParsedTransaction
): EarnProviderSettlement | null {
  const owner =
    movement.direction === "deposit" ? movement.source_address : movement.destination_address;
  const expectedMint = movement.direction === "deposit" ? position.share_mint : position.token_mint;
  if (
    !owner ||
    !expectedMint ||
    !movement.vault_address ||
    candidate.sourceSignature !== movement.signature ||
    candidate.owner !== owner ||
    candidate.tokenMint !== expectedMint ||
    !candidate.destinationSignature
  )
    throw new Error("Provider settlement identity differs from its recorded intent");
  if (
    !tx.executionResultKnown ||
    tx.err !== null ||
    !tx.accountKeys.includes(candidate.requiredAccount) ||
    !tx.instructions.some((ix) => ix.programId === candidate.programAddress)
  )
    return null;
  const delta = tokenBalanceDelta(tx, { mint: expectedMint, owner });
  if (delta === null || delta.baseUnits <= 0n) return null;
  return {
    outcome: "delivered",
    sourceSignature: candidate.sourceSignature,
    destinationSignature: candidate.destinationSignature,
    ownerAddress: owner,
    providerReference: movement.vault_address,
    tokenMint: expectedMint,
    amount: formatDecimalAmount(delta.baseUnits, delta.decimals),
    observedSlot: tx.slot.toString(),
  };
}

/** Independent from chain-leg polling: source finality leaves the economic obligation open. */
export async function reconcileEarnProviderOrders(env: Env): Promise<void> {
  const { environment } = currentClusterScope();
  const clients = new Map<string, EarnProviderSettlementProvider>();
  for (const provider of EARN_PROVIDERS) {
    const client = settlementClient(env, provider);
    if (client !== null) clients.set(provider, client);
  }
  if (clients.size === 0) return;
  const ledger = createPostgresEarnMovementsRepository(getDb(env));
  const failures: Error[] = [];
  // Claim only the item about to be processed. A stalled provider cannot consume
  // another item's lease; crashes retry after one minute with no signing or sending.
  for (let count = 0; count < 128; count++) {
    const [movement] = await ledger.claimProviderOrderMovements({
      environment,
      providers: [...clients.keys()],
      limit: 1,
      retryBefore: new Date(Date.now() - 60_000).toISOString(),
    });
    if (movement === undefined) break;
    try {
      const resolved = resolveEarnExecutionClient(env, movement.provider, createVaultDeadline());
      const client = resolved !== null && supportsProviderSettlement(resolved) ? resolved : null;
      const owner =
        movement.direction === "deposit" ? movement.source_address : movement.destination_address;
      if (!client || !owner || !movement.vault_address || !movement.signature)
        throw new Error("Provider order lacks its recorded execution identity");
      const candidate = await client.readProviderSettlement(earnRuntime(env), {
        providerReference: movement.vault_address,
        owner,
        sourceSignature: movement.signature,
        direction: movement.direction,
      });
      if (candidate.phase === "recovery_required")
        getLogger().warn(
          {
            movementId: movement.id,
            provider: movement.provider,
            event: "earn_provider_order_recovery_required",
          },
          "Earn provider order requires recovery"
        );
      if (candidate.destinationSignature === null) continue;
      const tx = await getTransaction(
        createClusterRpc(),
        signature(candidate.destinationSignature),
        "finalized"
      );
      if (tx === null) continue;
      const position = await ledger.getPositionById({
        organizationId: movement.organization_id,
        environment,
        positionId: movement.position_id,
      });
      if (!position) throw new Error("Provider order position is missing");
      const evidence = verifyProviderDelivery(movement, position, candidate, tx);
      if (evidence === null) continue;
      const observedAt = new Date().toISOString();
      await ledger.advanceVaultMovement({
        movementId: movement.id,
        organizationId: movement.organization_id,
        toStatus: "finalized",
        confirmedAt: observedAt,
        settledAt: observedAt,
        providerSettlement: evidence,
        ...(movement.direction === "deposit"
          ? { sharesOut: evidence.amount }
          : { tokenAmountSettled: evidence.amount }),
      });
    } catch (cause) {
      getLogger().error(
        {
          movementId: movement.id,
          provider: movement.provider,
          event: "earn_provider_settlement_failed",
        },
        "Earn provider settlement could not be verified"
      );
      failures.push(new Error(`Provider settlement failed for ${movement.id}`, { cause }));
    }
  }
  if (failures.length > 0)
    throw new AggregateError(failures, "Earn provider settlement reconciliation failed");
}

function settlementClient(env: Env, provider: string): EarnProviderSettlementProvider | null {
  const client = resolveEarnExecutionClient(env, provider, createVaultDeadline());
  return client !== null && supportsProviderSettlement(client) ? client : null;
}
