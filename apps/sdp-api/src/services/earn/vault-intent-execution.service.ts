import { createClusterRpc } from "@sdp/rpc/factory";
import { getDb } from "@/db/client";
import {
  createPostgresEarnMovementsRepository,
  type EarnMovementRow,
} from "@/db/repositories/earn-movements.repository";
import { internalError } from "@/lib/errors";
import { getLogger } from "@/runtime/logger";
import type { Env } from "@/types/env";
import type { VaultDeadline } from "./vault-deadline";
import { broadcastVaultTransaction } from "./vault-execution.service";

/**
 * Vault programs' own words for "your floor was too high", as Anchor writes
 * them into simulation logs. Veda reports `SlippageExceeded`; Jupiter Lend
 * reports `FTokenMinAmountOut`. Matched on NAMED errors, never bare custom
 * error numbers: the same number can mean unrelated things across programs.
 */
const SLIPPAGE_SIMULATION_MARKERS = [
  "SlippageExceeded",
  "Slippage tolerance exceeded",
  // biome-ignore lint/security/noSecrets: public Kamino Anchor error name.
  "SharesOutBelowMinimum",
  // biome-ignore lint/security/noSecrets: public Jupiter Lend Anchor error name.
  "FTokenMinAmountOut",
  // biome-ignore lint/security/noSecrets: public Jupiter Lend Anchor error name.
  "fTokenMinAmountOut",
] as const;

export function isSlippageSimulationFailure(error: string, logs: readonly string[]): boolean {
  return SLIPPAGE_SIMULATION_MARKERS.some(
    (marker) => error.includes(marker) || logs.some((log) => log.includes(marker))
  );
}

/** Interactive budget for a block-height read that only gates an early answer. */
const BLOCK_HEIGHT_READ_TIMEOUT_MS = 2_000;

/**
 * The scope cluster's confirmed block height, the same commitment the build's
 * `lastValidBlockHeight` was quoted at and the reconciler compares against.
 */
export async function readConfirmedBlockHeight(
  rpc: ReturnType<typeof createClusterRpc> = createClusterRpc({
    timeoutMs: BLOCK_HEIGHT_READ_TIMEOUT_MS,
  })
): Promise<bigint> {
  return rpc.getBlockHeight({ commitment: "confirmed" }).send();
}

/**
 * The invariant tail past the durable write, shared by every vault money
 * mover: broadcast the recorded bytes, then reconcile the optimistic
 * `submitted` transition. A broadcast error is ambiguous and leaves the
 * durable `requested` row for the shared reconciler. Even an expired-blockhash
 * refusal describes only this broadcast attempt: a wallet or a
 * concurrent reconciler may already have sent the exact signed transaction.
 *
 * The operation worker reaches this helper only after the signed transaction
 * has been recorded durably.
 */
export async function broadcastRecordedVaultMovement(
  env: Env,
  input: {
    operation: string;
    organizationId: string;
    deadline: VaultDeadline;
    bytes: Uint8Array;
    signature: string;
    movement: EarnMovementRow;
  }
): Promise<EarnMovementRow> {
  try {
    await broadcastVaultTransaction({
      deadline: input.deadline,
      bytes: input.bytes,
    });
  } catch (error) {
    getLogger().error(
      { movementId: input.movement.id, signature: input.signature, error },
      `vault ${input.operation}: broadcast outcome unknown; left reconcilable`
    );
    return input.movement;
  }

  const ledger = createPostgresEarnMovementsRepository(getDb(env));
  const advanced = await ledger.advanceVaultMovement({
    movementId: input.movement.id,
    organizationId: input.organizationId,
    toStatus: "submitted",
  });
  if (advanced) return advanced;

  const observed = await ledger.getMovementById({
    movementId: input.movement.id,
    organizationId: input.organizationId,
  });
  if (observed?.signature === input.signature) {
    return observed;
  }
  throw internalError(
    `Vault ${input.operation} was broadcast but its ledger transition could not be verified`
  );
}
