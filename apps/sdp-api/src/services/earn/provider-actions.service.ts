import {
  supportsProviderOrderCancellation,
  supportsVaultPreparation,
} from "@sdp/earn/capabilities";
import { notImplemented } from "@sdp/earn/errors";
import type { EarnVaultTransactionPlan } from "@sdp/earn/types";
import type { FeePaymentPort } from "@sdp/fee-payment/port";
import { createClusterRpc } from "@sdp/rpc/factory";
import { currentClusterScope } from "@sdp/rpc/scope";
import { getSignatureStatuses, sendTransaction } from "@sdp/rpc/solana";
import {
  type EarnProviderActionStatus,
  isEarnProviderActionChainStatus,
} from "@sdp/types/earn-provider-orders";
import type { MovementId } from "@sdp/types/movements";
import { address, signature } from "@solana/kit";
import { type DatabaseClient, getDb } from "@/db/client";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import {
  createPostgresEarnMovementsRepository,
  type EarnMovementRow,
} from "@/db/repositories/earn-movements.repository";
import {
  createEarnProviderActionsRepository,
  type EarnProviderActionClaim,
  type EarnProviderActionRow,
} from "@/db/repositories/earn-provider-actions.repository";
import { badRequest, conflict, internalError, providerUnavailable } from "@/lib/errors";
import { assertMoneyStartAdmitted } from "@/lib/money-admission";
import { getLogger } from "@/runtime/logger";
import { createOrgSignerForCustodyWallet } from "@/services/solana/signer";
import type { SponsorshipFeePayment } from "@/services/sponsorship.service";
import type { Env } from "@/types/env";
import { resolveEarnExecutionClient } from "./execution-registry";
import { earnRuntime } from "./runtime";
import { createVaultDeadline } from "./vault-deadline";
import {
  appendVaultRequestMemo,
  assertVaultSignaturesPreserved,
  compileUnsignedVaultTransaction,
  signVaultOwnerOnly,
  signVaultPlan,
  simulateVaultPlan,
} from "./vault-execution.service";
import { verifySignedExternalWalletTransaction } from "./vault-external-wallet.service";
import { rethrowVaultProviderFailure } from "./vault-refusals";
import { resolveVaultSponsorship, type VaultFeeMode } from "./vault-sponsorship";

const ACTION_MOVEMENTS = {
  preparation: "earn.prepare",
  cancellation: "earn.provider_order_cancel",
} as const satisfies Record<EarnProviderActionClaim["action"], MovementId>;
function isOwnedFeePayment(payment: FeePaymentPort): payment is SponsorshipFeePayment {
  return (
    "prepareOwnedSubmission" in payment && typeof payment.prepareOwnedSubmission === "function"
  );
}
const scopeOf = (row: EarnProviderActionRow) => ({
  organizationId: row.organization_id,
  projectId: row.project_id,
  actionId: row.id,
  preparationLeaseUntil: row.lease_until,
});

/** A movement that still names a pending provider order a cancellation may clear. */
type CancellableParent = EarnMovementRow & { signed_transaction: string };

/**
 * Whether `parent` is the pending provider order a cancellation build selected.
 * Shared by the build and submit gates so a build is only ever accepted while
 * its selected redemption is the one still pending: Plume's cancellation clears
 * every pending standard redemption for the wallet and vault, so bytes built
 * against a redemption that settled since preparation would cancel a newer
 * order instead.
 */
function isCancellableProviderOrder(
  parent: EarnMovementRow | null,
  row: EarnProviderActionRow
): parent is CancellableParent {
  return Boolean(
    parent &&
      parent.project_id === row.project_id &&
      parent.signed_transaction &&
      parent.status !== "finalized" &&
      parent.status !== "failed" &&
      parent.chain_finalized_at !== null
  );
}

/** Claim before builds or signatures. A retry of recorded bytes never creates another transaction. */
export async function claimProviderAction(
  env: Env,
  input: EarnProviderActionClaim,
  db: DatabaseClient = getDb(env)
): Promise<{ row: EarnProviderActionRow; owned: boolean }> {
  const claim = await createEarnProviderActionsRepository(db).claim(input);
  if (!claim.owned && claim.row.status === "preparing")
    throw providerUnavailable(
      "This provider action is being prepared. Retry shortly with the same key."
    );
  return claim;
}

/** Builds, signs and broadcasts a claimed action; only its claim's owner runs the provider tail. */
export async function executeClaimedProviderAction(
  env: Env,
  claim: { row: EarnProviderActionRow; owned: boolean },
  admit?: () => Promise<void>
): Promise<EarnProviderActionRow> {
  if (!claim.owned) return claim.row;
  try {
    return await executeProviderAction(env, claim.row, admit);
  } catch (cause) {
    await createEarnProviderActionsRepository(getDb(env)).releasePreparation(scopeOf(claim.row));
    throw cause;
  }
}

/** Composition of the claim and its execution, for callers without an audited transaction. */
export async function createProviderAction(
  env: Env,
  input: EarnProviderActionClaim,
  admit?: () => Promise<void>
): Promise<EarnProviderActionRow> {
  return executeClaimedProviderAction(env, await claimProviderAction(env, input), admit);
}

async function executeProviderAction(
  env: Env,
  row: EarnProviderActionRow,
  admit?: () => Promise<void>
): Promise<EarnProviderActionRow> {
  const db = getDb(env),
    repo = createEarnProviderActionsRepository(db),
    scope = scopeOf(row),
    deadline = createVaultDeadline();

  if (admit !== undefined) await admit();
  const movement = ACTION_MOVEMENTS[row.action];
  await assertMoneyStartAdmitted(
    env,
    { organizationId: row.organization_id, projectId: row.project_id },
    { surface: "http", movement, subjectId: row.id },
    { custodyWalletId: row.custody_wallet_id }
  );
  const client = resolveEarnExecutionClient(env, row.provider, deadline);
  if (client === null) throw notImplemented(row.provider, "provider actions");
  const fee = await providerActionFee(env, row, deadline);
  let rentPayer: string | undefined;
  switch (fee.kind) {
    case "wallet-pays":
      rentPayer = undefined;
      break;
    case "sponsored":
      rentPayer = fee.sponsor;
      break;
    case "caller-provided":
      rentPayer = fee.feePayer;
      break;
    default: {
      const unhandled: never = fee;
      throw internalError(`Unknown provider action fee mode ${String(unhandled)}`);
    }
  }
  let plan = await buildProviderActionPlan(env, row, client, rentPayer, deadline);
  if (row.action === "preparation" && plan.instructions.length === 0) {
    const ready = await repo.advance(scope, "preparing", "not_required");
    if (ready === null) throw conflict("Provider action ownership changed");
    return ready;
  }
  plan = appendVaultRequestMemo(plan, "vault-withdrawal-cancel", row.id);
  const identity = { depositTokenMint: row.token_mint, shareMint: row.share_mint };
  const simulation = await simulateVaultPlan({
    plan,
    fee,
    owner: address(row.owner_address),
    deadline,
    expectedAssetIdentity: identity,
  });
  if (!simulation.ok) throw badRequest(`Provider action simulation failed: ${simulation.error}`);
  if (row.custody_wallet_id === null) {
    const unsigned = compileUnsignedVaultTransaction({
      plan,
      owner: address(row.owner_address),
      feePayer: row.fee_payer === null ? undefined : address(row.fee_payer),
      deadline,
      expectedAssetIdentity: identity,
      prepared: simulation.prepared,
    });
    const prepared = await repo.advance(scope, "preparing", "prepared", {
      unsigned_transaction: Buffer.from(unsigned.bytes).toString("base64"),
      last_valid_block_height: unsigned.lastValidBlockHeight,
    });
    if (!prepared) throw conflict("Provider action was advanced by another request");
    return prepared;
  }
  return executeCustodyProviderAction(env, row, plan, fee, simulation.prepared, deadline);
}

export async function submitExternalProviderAction(
  env: Env,
  row: EarnProviderActionRow,
  signedTransaction: string
): Promise<EarnProviderActionRow> {
  const { environment } = currentClusterScope();
  if (
    row.environment !== environment ||
    row.custody_wallet_id !== null ||
    row.unsigned_transaction === null
  )
    throw badRequest("This action is not an external-wallet build");
  if (row.status !== "prepared") return row;
  const signed = await verifySignedExternalWalletTransaction(
    { ...row, unsigned_transaction: row.unsigned_transaction },
    signedTransaction
  );
  const repo = createEarnProviderActionsRepository(getDb(env)),
    scope = scopeOf(row);
  // The build may be older than the ledger: a redemption that settled since
  // preparation leaves a stale cancellation whose bytes would clear whatever
  // redemption is pending now. Recheck the selected parent as the last gate
  // before the claim accepts the bytes.
  if (row.action === "cancellation" && row.parent_movement_id !== null) {
    const parent = await createPostgresEarnMovementsRepository(getDb(env)).getMovementById({
      organizationId: row.organization_id,
      movementId: row.parent_movement_id,
    });
    if (!isCancellableProviderOrder(parent, row))
      throw conflict("The provider order is no longer pending");
  }
  let claimed: EarnProviderActionRow | null;
  try {
    claimed = await repo.advance(scope, "prepared", "requested", {
      signed_transaction: signed.signedTransactionBase64,
      signature: signed.signature,
    });
  } catch (cause) {
    if (!isPostgresUniqueViolation(cause)) throw cause;
    // Two prepared builds for one movement cannot both become requested: the
    // one-active-cancellation index excludes `prepared`, so the second submit
    // loses the race at this transition. `prepared → failed` is not a legal
    // transition, so the loser reports the surviving action instead of a
    // database error.
    const surviving =
      row.action === "cancellation" && row.parent_movement_id !== null
        ? await repo.findActiveCancellation(scope, row.parent_movement_id)
        : null;
    if (surviving === null) throw conflict("This provider action was already submitted");
    return surviving;
  }
  if (claimed !== null) {
    await repo.advance(scope, "requested", "submitted");
    try {
      await sendTransaction(createClusterRpc({ timeoutMs: 5_000 }), signed.bytes);
    } catch (cause) {
      getLogger().warn(
        { actionId: row.id, errorName: cause instanceof Error ? cause.name : "unknown" },
        "External provider action broadcast outcome remains unknown"
      );
      // Submission may already have happened in the caller's wallet; keep the exact bytes recoverable.
    }
  }
  const current = await repo.get(scope);
  if (!current) throw internalError("Provider action disappeared after submission");
  return current;
}

/** Scoped read-through for prompt first-deposit setup; the sweep remains the durable fallback. */
export async function readProviderAction(
  env: Env,
  row: EarnProviderActionRow
): Promise<EarnProviderActionRow> {
  if (row.signature === null || !isEarnProviderActionChainStatus(row.status)) return row;
  const [observed] = await getSignatureStatuses(
    createClusterRpc({ timeoutMs: 5_000 }),
    [signature(row.signature)],
    { searchTransactionHistory: true }
  );
  if (observed?.confirmationStatus !== "finalized") return row;
  const repo = createEarnProviderActionsRepository(getDb(env)),
    scope = scopeOf(row);
  let target: EarnProviderActionStatus;
  switch (row.action) {
    case "preparation":
      target = observed.err === null ? "finalized" : "failed";
      break;
    case "cancellation":
      target = observed.err === null ? "awaiting_delivery" : "failed";
      break;
    default: {
      const unhandled: never = row.action;
      throw internalError(`Unknown provider action kind ${String(unhandled)}`);
    }
  }
  const advanced = await repo.advance(scope, row.status, target, {
    error: observed.err !== null ? "Source transaction failed on chain" : null,
  });
  if (advanced !== null) return advanced;
  // A competing update moved the row on, so the fresh read is the answer; its
  // absence is a broken invariant, never stale state to replay.
  const current = await repo.get(scope);
  if (current === null)
    throw internalError("Provider action disappeared while reading its outcome");
  return current;
}

async function buildProviderActionPlan(
  env: Env,
  row: EarnProviderActionRow,
  client: NonNullable<ReturnType<typeof resolveEarnExecutionClient>>,
  rentPayer: string | undefined,
  deadline: ReturnType<typeof createVaultDeadline>
): Promise<EarnVaultTransactionPlan> {
  const db = getDb(env);
  let plan: EarnVaultTransactionPlan;
  try {
    if (row.action === "preparation") {
      if (!supportsVaultPreparation(client))
        throw notImplemented(row.provider, "vault account preparation");
      plan = await deadline.run("Building vault account preparation", () =>
        client.buildVaultPreparation(earnRuntime(env), {
          providerReference: row.vault_address,
          owner: row.owner_address,
          rentPayer,
        })
      );
    } else {
      if (!supportsProviderOrderCancellation(client))
        throw notImplemented(row.provider, "provider-order cancellation");
      if (row.parent_movement_id === null) throw internalError("Cancellation parent is missing");
      const parent = await createPostgresEarnMovementsRepository(db).getMovementById({
        organizationId: row.organization_id,
        movementId: row.parent_movement_id,
      });
      if (!isCancellableProviderOrder(parent, row))
        throw conflict("The provider order cannot be cancelled");
      const sourceTransaction = parent.signed_transaction;
      plan = await deadline.run("Building provider-order cancellation", () =>
        client.buildProviderOrderCancellation(earnRuntime(env), {
          providerReference: row.vault_address,
          owner: row.owner_address,
          sourceTransaction,
          rentPayer,
        })
      );
    }
  } catch (cause) {
    rethrowVaultProviderFailure(cause);
  }
  return plan;
}

async function providerActionFee(
  env: Env,
  row: EarnProviderActionRow,
  deadline: ReturnType<typeof createVaultDeadline>
): Promise<VaultFeeMode> {
  const movement = ACTION_MOVEMENTS[row.action];
  let fee: VaultFeeMode;
  if (row.custody_wallet_id === null)
    fee =
      row.fee_payer === null
        ? { kind: "wallet-pays" }
        : { kind: "caller-provided", feePayer: address(row.fee_payer) };
  else
    fee = await resolveVaultSponsorship(env, {
      movement,
      organizationId: row.organization_id,
      projectId: row.project_id,
      walletId: row.custody_wallet_id,
      deadline,
    });
  return fee;
}

async function executeCustodyProviderAction(
  env: Env,
  row: EarnProviderActionRow,
  plan: EarnVaultTransactionPlan,
  fee: VaultFeeMode,
  prepared: Parameters<typeof signVaultOwnerOnly>[0]["prepared"],
  deadline: ReturnType<typeof createVaultDeadline>
): Promise<EarnProviderActionRow> {
  if (row.custody_wallet_id === null) throw internalError("Expected a custody provider action");
  const repo = createEarnProviderActionsRepository(getDb(env)),
    scope = scopeOf(row),
    identity = { depositTokenMint: row.token_mint, shareMint: row.share_mint },
    movement = ACTION_MOVEMENTS[row.action];
  const signer = await createOrgSignerForCustodyWallet<"earn">(
    env,
    row.organization_id,
    row.project_id,
    row.custody_wallet_id,
    movement
  );
  if (signer.address !== row.owner_address)
    throw badRequest("Provider action signer does not match its owner");
  if (fee.kind === "sponsored") {
    if (!isOwnedFeePayment(fee.feePayment))
      throw internalError("Provider action sponsorship requires an owned submission");
    const ownerSigned = await signVaultOwnerOnly({
      plan,
      owner: signer,
      fee,
      deadline,
      expectedAssetIdentity: identity,
      prepared,
    });
    let persistenceUnknown = false;
    try {
      const submission = await fee.feePayment.prepareOwnedSubmission(ownerSigned.bytes, {
        async persistSigned(signed) {
          assertVaultSignaturesPreserved(ownerSigned.bytes, signed.signedTransaction);
          let saved: EarnProviderActionRow | null;
          try {
            saved = await repo.advance(scope, "preparing", "requested", {
              signature: signed.signature,
              signed_transaction: Buffer.from(signed.signedTransaction).toString("base64"),
              last_valid_block_height: ownerSigned.lastValidBlockHeight,
              fee_payer: fee.sponsor,
            });
          } catch (cause) {
            // A commit whose reply was lost still leaves recorded bytes the
            // reconciler can send. Swallowing keeps the sponsorship reservation
            // that spending must stay accountable to; the durable re-read below
            // is the only authority on whether the bytes were recorded.
            persistenceUnknown = true;
            getLogger().error(
              { actionId: row.id, error: cause },
              "Provider action submission persistence outcome is unknown"
            );
            return;
          }
          if (saved === null) throw conflict("Provider action ownership changed before submission");
        },
        async markStarted() {
          // The persisted domain outbox is the start marker. Its reconciler may
          // also send these bytes, so no later refusal releases this reservation.
        },
      });
      if (persistenceUnknown)
        throw internalError("Provider action submission could not be recorded durably");
      await repo.advance(scope, "requested", "submitted");
      await broadcastProviderAction(row, submission.signedTransaction);
    } catch (cause) {
      const recorded = await repo.get(scope);
      if (recorded === null || recorded.signed_transaction === null) throw cause;
      return recorded;
    }
  } else {
    const signed = await signVaultPlan({
      plan,
      owner: signer,
      fee,
      deadline,
      expectedAssetIdentity: identity,
      prepared,
    });
    if (
      !(await repo.advance(scope, "preparing", "requested", {
        signature: signed.signature,
        signed_transaction: Buffer.from(signed.bytes).toString("base64"),
        last_valid_block_height: signed.lastValidBlockHeight,
      }))
    )
      throw conflict("Another request recorded this provider action");
    await repo.advance(scope, "requested", "submitted");
    await broadcastProviderAction(row, signed.bytes);
  }
  const saved = await repo.get(scope);
  if (!saved) throw internalError("Provider action disappeared after submission");
  return saved;
}

async function broadcastProviderAction(
  row: EarnProviderActionRow,
  bytes: Uint8Array
): Promise<void> {
  try {
    await sendTransaction(createClusterRpc({ timeoutMs: 5_000 }), bytes);
  } catch (cause) {
    getLogger().warn(
      { actionId: row.id, errorName: cause instanceof Error ? cause.name : "unknown" },
      "Provider action broadcast outcome remains unknown; recorded bytes remain recoverable"
    );
  }
}
