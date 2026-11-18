import { createClusterRpc } from "@sdp/rpc/factory";
import { currentClusterScope } from "@sdp/rpc/scope";
import type { EarnPositionSource } from "@sdp/types/earn-core";
import type { OperationReference } from "@sdp/types/operations";
import { signature } from "@solana/kit";
import { getDb } from "@/db/client";
import {
  createPostgresEarnSplitSwapAdvisoriesRepository,
  type EarnSplitSwapAdvisoryRow,
  type EarnSwapOperationScope,
} from "@/db/repositories/earn-split-swap-advisories.repository";
import { conflict, notFound } from "@/lib/errors";
import type { Env } from "@/types/env";
import type {
  PreparedStrategySigningTarget,
  StrategyTransactionScope,
} from "./strategy-transactions.service";
import { createVaultDeadline } from "./vault-deadline";
import { broadcastVaultTransaction } from "./vault-execution.service";
import { verifySignedExternalWalletTransaction } from "./vault-external-wallet.service";
import { readConfirmedBlockHeight } from "./vault-intent-execution.service";

export type PreparedSwapStrategyTransaction = EarnSplitSwapAdvisoryRow & {
  unsigned_transaction: string;
};

/** This is a new reviewable deposit quantity, never an observed swap payout. */
export interface SwapStrategyContinuation {
  strategyId: string;
  source: EarnPositionSource;
  depositTokenMint: string;
  minOutAmount: string;
}

function operationScope(scope: StrategyTransactionScope): EarnSwapOperationScope {
  return { ...scope, environment: currentClusterScope().environment };
}

/** Resolve one exact plan without borrowing another project's or wallet's build. */
export async function requirePreparedSwapStrategyTransaction(
  env: Env,
  scope: StrategyTransactionScope,
  advisoryId: string
): Promise<PreparedSwapStrategyTransaction> {
  const row = await createPostgresEarnSplitSwapAdvisoriesRepository(getDb(env)).getForOperation(
    operationScope(scope),
    advisoryId
  );
  if (row === null) throw notFound("Prepared strategy swap");
  if (row.unsigned_transaction === null) {
    throw conflict("This historical swap has no stored message; prepare a new operation");
  }
  return { ...row, unsigned_transaction: row.unsigned_transaction };
}

/** Custody swaps use the same admitted deposit signer; the message fixes its payer. */
export function swapStrategySigningTarget(
  row: PreparedSwapStrategyTransaction
): PreparedStrategySigningTarget {
  return {
    id: row.id,
    owner_address: row.owner_address,
    unsigned_transaction: row.unsigned_transaction,
    last_valid_block_height: row.swap_last_valid_block_height,
    fee_mode: row.fee_payer === null ? "wallet" : "partner",
    fee_payer: row.fee_payer,
    movement: "earn.deposit",
  };
}

export function swapStrategyContinuation(
  row: PreparedSwapStrategyTransaction
): SwapStrategyContinuation {
  return {
    strategyId: row.strategy_id,
    source:
      row.custody_wallet_id === null
        ? { ownerAddress: row.owner_address }
        : { walletId: row.custody_wallet_id },
    depositTokenMint: row.deposit_token_mint,
    minOutAmount: row.swap_min_out_amount,
  };
}

async function readSwapSignature(transactionSignature: string) {
  const observation = await createClusterRpc()
    .getSignatureStatuses([signature(transactionSignature)], { searchTransactionHistory: true })
    .send();
  return observation.value[0] ?? null;
}

type SwapSignatureObservation = NonNullable<Awaited<ReturnType<typeof readSwapSignature>>>;

async function recordObservation(
  env: Env,
  scope: StrategyTransactionScope,
  row: PreparedSwapStrategyTransaction,
  observation: SwapSignatureObservation
): Promise<PreparedSwapStrategyTransaction> {
  if (row.swap_signature === null) throw conflict("The swap has no accepted signature");
  // A confirmed error can disappear with its fork. Missing history and expiry
  // never authorize either failure or a new financial action.
  const committed = observation.confirmationStatus === "finalized";
  const status =
    observation.err !== null && committed
      ? "failed"
      : observation.err === null && observation.confirmationStatus === "finalized"
        ? "finalized"
        : "submitted";
  const updated = await createPostgresEarnSplitSwapAdvisoriesRepository(
    getDb(env)
  ).recordOperationObservation(operationScope(scope), {
    advisoryId: row.id,
    signature: row.swap_signature,
    status,
    slot: String(observation.slot),
    failureReason: status === "failed" ? "The prerequisite swap failed on Solana" : null,
  });
  if (updated === null) return requirePreparedSwapStrategyTransaction(env, scope, row.id);
  return { ...updated, unsigned_transaction: row.unsigned_transaction };
}

/**
 * The operation attempt already holds signed bytes. Bind their signature before
 * the first send; the advisory never stores another signed outbox or movement.
 */
export async function submitPreparedSwapStrategyAction(
  env: Env,
  input: StrategyTransactionScope & {
    advisoryId: string;
    signedTransaction: string;
    broadcast: boolean;
  }
): Promise<OperationReference> {
  const row = await requirePreparedSwapStrategyTransaction(env, input, input.advisoryId);
  const signed = await verifySignedExternalWalletTransaction(
    swapStrategySigningTarget(row),
    input.signedTransaction
  );
  const observed =
    !input.broadcast && row.swap_observed_slot === null
      ? await readSwapSignature(signed.signature)
      : null;
  if (!input.broadcast && row.swap_observed_slot === null && observed === null) {
    throw conflict("Cancellation is waiting for the original swap signature observation");
  }
  const recorded = await createPostgresEarnSplitSwapAdvisoriesRepository(
    getDb(env)
  ).recordOperationSignature(operationScope(input), row.id, signed.signature);
  if (recorded === null) throw conflict("The swap was accepted with different signed bytes");
  if (observed !== null) {
    await recordObservation(
      env,
      input,
      { ...recorded.row, unsigned_transaction: row.unsigned_transaction },
      observed
    );
  }
  if (input.broadcast && !recorded.replayed) {
    await broadcastVaultTransaction({ deadline: createVaultDeadline(), bytes: signed.bytes });
  }
  return { kind: "earn.swap", id: row.id };
}

/**
 * Recovery resends only the immutable signed attempt. The same signature cannot
 * execute twice, including a crash between signature persistence and first send.
 * One confirmed-height read and at most one send, no new quote, build or signer.
 */
export async function retryPreparedSwapStrategyAction(
  env: Env,
  input: StrategyTransactionScope & { advisoryId: string; signedTransaction: string }
): Promise<boolean> {
  const row = await requirePreparedSwapStrategyTransaction(env, input, input.advisoryId);
  const signed = await verifySignedExternalWalletTransaction(
    swapStrategySigningTarget(row),
    input.signedTransaction
  );
  if (row.swap_signature !== signed.signature)
    throw conflict("Swap recovery must reuse its accepted signature");
  if (row.swap_chain_status === "finalized" || row.swap_chain_status === "failed") return false;
  if ((await readConfirmedBlockHeight()) > BigInt(row.swap_last_valid_block_height)) return false;
  await broadcastVaultTransaction({ deadline: createVaultDeadline(), bytes: signed.bytes });
  return true;
}

/** One status RPC per nonterminal prerequisite; terminal persisted observations need none. */
export async function observePreparedSwapStrategyAction(
  env: Env,
  scope: StrategyTransactionScope,
  advisoryId: string
) {
  let row = await requirePreparedSwapStrategyTransaction(env, scope, advisoryId);
  let observed = row.swap_observed_slot !== null;
  if (row.swap_signature !== null && row.swap_chain_status === "submitted") {
    const observation = await readSwapSignature(row.swap_signature);
    observed = observation !== null;
    if (observation !== null) row = await recordObservation(env, scope, row, observation);
  }
  return {
    row,
    observed,
    status: row.swap_chain_status,
    signature: row.swap_signature,
    finalizationSlot: row.swap_chain_status === "finalized" ? row.swap_observed_slot : null,
    continuation: row.swap_chain_status === "finalized" ? swapStrategyContinuation(row) : null,
  };
}
