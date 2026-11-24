import { createHash } from "node:crypto";
import { currentClusterScope } from "@sdp/rpc/scope";
import { canonicalJson } from "@sdp/types/idempotency";
import type { MovementOf } from "@sdp/types/movements";
import {
  address,
  blockhash,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  getTransactionEncoder,
  isTransactionModifyingSigner,
  isTransactionPartialSigner,
  partiallySignTransactionWithSigners,
} from "@solana/kit";
import {
  asTransactionalClient,
  type DatabaseClient,
  type DatabaseExecutor,
  getDb,
} from "@/db/client";
import {
  claimDiscoveredStrategyPosition,
  createPostgresEarnMovementsRepository,
  type EarnMovementRow,
  type EarnPositionRow,
} from "@/db/repositories/earn-movements.repository";
import {
  createPostgresEarnWalletTransactionsRepository,
  type EarnWalletTransactionRow,
} from "@/db/repositories/earn-wallet-transactions.repository";
import { conflict, internalError, notFound } from "@/lib/errors";
import { MAX_CUSTODY_SIGNING_TIMEOUT_MS } from "@/services/domain/signing/signing-timeout";
import { createOrgSignerForCustodyWallet } from "@/services/solana/signer";
import type { Env } from "@/types/env";
import {
  OPERATION_WORKER_BOUNDARY_MS,
  type OperationWorkerBudget,
} from "./operation-worker-budget";
import { createVaultDeadline } from "./vault-deadline";
import { ledgerVaultExposureGate } from "./vault-exposure";
import { broadcastRecordedVaultMovement } from "./vault-intent-execution.service";
import { resolveVaultSponsorship } from "./vault-sponsorship";
import { verifySignedWalletTransaction } from "./vault-wallet.service";

/** The durable result of one prepared strategy action. */
export interface PreparedStrategyTransactionResult {
  position: EarnPositionRow;
  movement: EarnMovementRow;
  replayed: boolean;
}

/** An authenticated operation chooses the source; a signed body cannot change it. */
export interface StrategyTransactionScope {
  organizationId: string;
  projectId: string;
  custodyWalletId: string | null;
}

/** Exact prepared bytes plus their named admission action, shared by all steps. */
export type PreparedStrategySigningTarget = Pick<
  EarnWalletTransactionRow,
  | "id"
  | "owner_address"
  | "unsigned_transaction"
  | "last_valid_block_height"
  | "fee_mode"
  | "fee_payer"
> & { movement: MovementOf<"earn"> };

/** Add the admitted owner signature to the exact message shown at preparation. */
export async function signPreparedStrategyTransaction(
  env: Env,
  scope: StrategyTransactionScope,
  built: PreparedStrategySigningTarget,
  workerBudget?: OperationWorkerBudget
): Promise<string> {
  if (scope.custodyWalletId === null) throw internalError("An owner signs outside SDP");
  const movement = built.movement;
  const signer = await createOrgSignerForCustodyWallet<"earn">(
    env,
    scope.organizationId,
    scope.projectId,
    scope.custodyWalletId,
    movement
  );
  if (
    signer.address !== built.owner_address ||
    (!isTransactionPartialSigner(signer) && !isTransactionModifyingSigner(signer))
  ) {
    throw conflict("Prepared strategy owner no longer matches its custody wallet");
  }
  const original = getTransactionDecoder().decode(
    Buffer.from(built.unsigned_transaction, "base64")
  );
  const compiled = getCompiledTransactionMessageDecoder().decode(original.messageBytes);
  const transaction = {
    ...original,
    lifetimeConstraint: {
      blockhash: blockhash(compiled.lifetimeToken),
      lastValidBlockHeight: BigInt(built.last_valid_block_height),
    },
  };
  workerBudget?.assertCanStart(
    MAX_CUSTODY_SIGNING_TIMEOUT_MS +
      (built.fee_mode === "sponsored" ? OPERATION_WORKER_BOUNDARY_MS : 0)
  );
  const signed = await partiallySignTransactionWithSigners([signer], transaction);
  const signedBytes = new Uint8Array(getTransactionEncoder().encode(signed));
  if (!Buffer.from(signed.messageBytes).equals(Buffer.from(original.messageBytes))) {
    throw conflict("Custody signer changed the prepared strategy transaction");
  }
  for (const [key, signature] of Object.entries(original.signatures)) {
    if (signature === null) continue;
    const after = signed.signatures[address(key)];
    if (
      after === undefined ||
      after === null ||
      !Buffer.from(signature).equals(Buffer.from(after))
    ) {
      throw conflict("Custody signer changed a prepared signature");
    }
  }
  return sponsorPreparedStrategyTransaction(
    env,
    scope,
    built,
    Buffer.from(signedBytes).toString("base64"),
    workerBudget
  );
}

/** Sponsorship must still use the same admitted payer embedded in the message. */
export async function sponsorPreparedStrategyTransaction(
  env: Env,
  scope: StrategyTransactionScope,
  built: PreparedStrategySigningTarget,
  ownerSignedTransaction: string,
  workerBudget?: OperationWorkerBudget
): Promise<string> {
  if (built.fee_mode !== "sponsored") return ownerSignedTransaction;
  if (scope.custodyWalletId === null) throw internalError("Owner signing has no SDP sponsor");
  workerBudget?.assertCanStart();
  const deadline = createVaultDeadline();
  const fee = await resolveVaultSponsorship(env, {
    ...scope,
    walletId: scope.custodyWalletId,
    deadline,
    movement: built.movement,
  });
  if (fee.kind !== "sponsored" || fee.sponsor !== built.fee_payer) {
    throw conflict("Prepared strategy sponsorship changed; refresh before signing");
  }
  workerBudget?.assertCanStart();
  const bytes = await deadline.run("Signing the sponsored strategy transaction", () =>
    fee.feePayment.signAsFeePayer(Uint8Array.from(Buffer.from(ownerSignedTransaction, "base64")))
  );
  const result = Buffer.from(bytes).toString("base64");
  await verifySignedWalletTransaction(built, result);
  return result;
}

/** Resolve an exact prepared message within its authorized source scope. */
export async function requirePreparedStrategyTransaction(
  env: Env,
  scope: StrategyTransactionScope,
  transactionId: string
): Promise<EarnWalletTransactionRow> {
  const built = await createPostgresEarnWalletTransactionsRepository(getDb(env)).getById({
    organizationId: scope.organizationId,
    transactionId,
  });
  if (
    built === null ||
    built.project_id !== scope.projectId ||
    built.environment !== currentClusterScope().environment ||
    built.custody_wallet_id !== scope.custodyWalletId
  )
    throw notFound("Prepared strategy transaction");
  return built;
}

async function replayConsumedStrategyTransaction(
  db: DatabaseClient,
  scope: StrategyTransactionScope,
  built: EarnWalletTransactionRow,
  movementId: string,
  signedTransaction: string
): Promise<PreparedStrategyTransactionResult> {
  const ledger = createPostgresEarnMovementsRepository(db);
  const movement = await ledger.getMovementById({
    organizationId: scope.organizationId,
    movementId,
  });
  if (
    movement === null ||
    movement.project_id !== scope.projectId ||
    movement.environment !== built.environment ||
    movement.signed_transaction !== signedTransaction
  ) {
    throw conflict("Prepared strategy transaction was consumed with different signed bytes");
  }
  const position = await ledger.getPositionById({
    organizationId: scope.organizationId,
    environment: built.environment,
    positionId: movement.position_id,
  });
  if (position === null) throw internalError("Recorded strategy position is missing");
  return { position, movement, replayed: true };
}

async function claimPreparedStrategyPosition(
  executor: DatabaseExecutor,
  built: EarnWalletTransactionRow,
  input: StrategyTransactionScope & { userId: string | null }
): Promise<string | null> {
  if (built.direction !== "withdrawal" || built.position_id !== null) return built.position_id;
  if (built.strategy_id === null)
    throw internalError("Discovered withdrawal has no strategy identity");
  const claimed = await claimDiscoveredStrategyPosition(
    {
      organizationId: input.organizationId,
      projectId: input.projectId,
      environment: built.environment,
      provider: built.provider,
      strategyId: built.strategy_id,
      strategyReference: built.vault_address,
      tokenMint: built.token_mint,
      shareMint: built.share_mint,
      label: built.label,
      createdBy: input.userId,
      source:
        input.custodyWalletId === null
          ? { ownerAddress: built.owner_address }
          : { walletId: input.custodyWalletId },
    },
    executor
  );
  await executor.execute(
    "UPDATE earn_wallet_transactions SET position_id = ? WHERE id = ? AND organization_id = ?",
    [claimed.id, built.id, input.organizationId]
  );
  return claimed.id;
}

/**
 * Verify, persist and broadcast one prepared strategy action. The source union
 * selects the existing ledger writer, preserving custody and owner claims.
 */
export async function submitPreparedStrategyTransaction(
  env: Env,
  input: StrategyTransactionScope & {
    transactionId: string;
    signedTransaction: string;
    requestId: string;
    userId: string | null;
    apiKeyId: string | null;
    broadcast?: boolean;
  }
): Promise<PreparedStrategyTransactionResult> {
  const built = await requirePreparedStrategyTransaction(env, input, input.transactionId);
  const custodyWalletId = input.custodyWalletId;
  const signed = await verifySignedWalletTransaction(built, input.signedTransaction);
  const fingerprint = createHash("sha256")
    .update(
      canonicalJson({
        kind: "earn.strategy-transaction",
        transactionId: built.id,
        custodyWalletId,
        projectId: input.projectId,
        direction: built.direction,
      })
    )
    .digest("hex");

  const result = await getDb(env).transaction(async (executor) => {
    const db = asTransactionalClient(executor);
    const locked = await db.queryOne<{ movement_id: string | null }>(
      `SELECT movement_id FROM earn_wallet_transactions
       WHERE id = ? AND organization_id = ? AND project_id = ?
         AND custody_wallet_id IS NOT DISTINCT FROM ? AND environment = ? FOR UPDATE`,
      [built.id, input.organizationId, input.projectId, custodyWalletId, built.environment]
    );
    if (locked === null) throw notFound("Prepared strategy transaction");
    const ledger = createPostgresEarnMovementsRepository(db);
    if (locked.movement_id !== null) {
      return replayConsumedStrategyTransaction(
        db,
        input,
        built,
        locked.movement_id,
        signed.signedTransactionBase64
      );
    }
    const positionId = await claimPreparedStrategyPosition(executor, built, input);
    const common = {
      organizationId: input.organizationId,
      projectId: input.projectId,
      environment: built.environment,
      provider: built.provider,
      vaultAddress: built.vault_address,
      shareMint: built.share_mint,
      signature: signed.signature,
      signedTransaction: signed.signedTransactionBase64,
      lastValidBlockHeight: built.last_valid_block_height,
      requestId: input.requestId,
      idempotencyFingerprint: fingerprint,
      createsShareAccount: built.creates_share_account,
      shareAtaRentFunder: built.share_ata_rent_funder,
      createdBy: input.userId,
      initiatedByKeyId: input.apiKeyId,
    };
    let recorded: PreparedStrategyTransactionResult;
    if (built.direction === "deposit") {
      const deposit = {
        ...common,
        tokenMint: built.token_mint,
        label: built.label,
        requestedAmount: built.amount_requested,
        acceptedMinSharesOut: built.min_shares_out,
        // Observed chain effects must be recorded even when new deposits are refused.
        admit:
          input.broadcast === false
            ? undefined
            : ledgerVaultExposureGate(env, {
                provider: built.provider,
                vaultAddress: built.vault_address,
                amount: built.amount_requested,
              }),
      };
      recorded =
        custodyWalletId === null
          ? await ledger.createSignedWalletDepositIntent({
              ...deposit,
              ownerAddress: built.owner_address,
              walletTransactionId: built.id,
            })
          : await ledger.createSignedVaultDepositIntent({
              ...deposit,
              custodyWalletId,
              sourceAddress: built.owner_address,
            });
    } else {
      if (positionId === null) throw internalError("Withdrawal names no position");
      const withdrawal = { ...common, positionId, requestedShares: built.amount_requested };
      recorded =
        custodyWalletId === null
          ? await ledger.createSignedWalletWithdrawalIntent({
              ...withdrawal,
              ownerAddress: built.owner_address,
              walletTransactionId: built.id,
            })
          : await ledger.createSignedVaultWithdrawalIntent({
              ...withdrawal,
              custodyWalletId,
              walletAddress: built.owner_address,
            });
    }
    if (locked.movement_id !== null && locked.movement_id !== recorded.movement.id) {
      throw conflict("Prepared strategy transaction was already consumed");
    }
    const consumed = await db.execute(
      `UPDATE earn_wallet_transactions
       SET movement_id = ?, consumed_at = COALESCE(consumed_at, sdp_iso_now()),
           updated_at = sdp_iso_now()
       WHERE id = ? AND organization_id = ?
         AND (movement_id IS NULL OR movement_id = ?)`,
      [recorded.movement.id, built.id, input.organizationId, recorded.movement.id]
    );
    if (consumed !== 1) throw conflict("Prepared strategy transaction was consumed concurrently");
    if (built.strategy_id !== null) {
      const linked = await db.execute(
        `UPDATE earn_positions SET strategy_id = ?
         WHERE id = ? AND organization_id = ? AND environment = ?
           AND (strategy_id IS NULL OR strategy_id = ?)`,
        [
          built.strategy_id,
          recorded.position.id,
          input.organizationId,
          built.environment,
          built.strategy_id,
        ]
      );
      if (linked !== 1) throw conflict("Position strategy identity changed");
    }
    return recorded;
  });
  if (result.replayed || input.broadcast === false) return result;
  const movement = await broadcastRecordedVaultMovement(env, {
    operation: `strategy ${built.direction}`,
    organizationId: input.organizationId,
    deadline: createVaultDeadline(),
    bytes: signed.bytes,
    signature: signed.signature,
    movement: result.movement,
  });
  return { ...result, movement };
}
