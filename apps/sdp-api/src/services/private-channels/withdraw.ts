/**
 * Private Channels withdrawal flow.
 *
 * Burns `amount` of the instance mint from the custody wallet's CHANNEL-chain
 * balance (via the withdraw program = an SPL Burn), then the operator later
 * releases the matching real USDC on devnet to `destination`. The burn is
 * server-signed by the custody wallet (the burn `user`) and broadcast to the
 * GATEWAY (the channel chain) — NOT devnet, unlike the deposit escrow tx.
 *
 * Signing model: SDP custody wallet, server-signed — same as deposits;
 * the wallet is the sole signer and (for now) self-pays the channel-chain fee.
 * TODO(gasless/fees): confirm the gateway fee model for gateway-broadcast txs and
 * wire a sponsored fee payer if the gateway requires one.
 *
 * Gateway auth: broadcasting the burn is a gateway WRITE and confirming it a
 * gateway READ — both JWT-gated. The caller's SPC session is resolved by the
 * handler and passed in as `gatewayAuth` (a self-refreshing handle, shared across
 * broadcast + confirm).
 *
 * Lifecycle here: pending (persist) → submitted (broadcast) → confirmed (burn
 * confirmed on the gateway). `settled` is reached asynchronously by the oracle
 * once the operator's devnet release is observed on the instance escrow ATA.
 * After `confirmed` the balance is authoritatively burned, so an unobservable
 * release is a settlement issue → operator alert, never auto-`failed`.
 */

import * as solanaRpc from "@sdp/rpc/solana";
import { parseDecimalAmount } from "@sdp/solana/amount";
import { getWithdrawFundsInstructionAsync } from "@sdp/spc-withdraw";
import type { PrivateChannelInstance } from "@sdp/types";
import { PRIVATE_CHANNEL_EVENT_TYPES, type PrivateChannelWithdrawal } from "@sdp/types";
import {
  type Address,
  address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getTransactionEncoder,
  pipe,
  type Signature,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { signTransactionMessageWithSigners } from "@solana/signers";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import {
  createPrivateChannelWithdrawalRepository,
  mapPrivateChannelWithdrawalRow,
  type PrivateChannelWithdrawalRepository,
  type PrivateChannelWithdrawalRow,
} from "@/db/repositories";
import { AppError, badRequest } from "@/lib/errors";
import {
  buildPrivateChannelWithdrawalFingerprint,
  resolveIdempotencyReplay,
} from "@/lib/idempotency";
import { getLogger } from "@/runtime/logger";
import * as solanaServices from "@/services/solana";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";
import { type SpcAuthContext, withGatewayRpc } from "./auth/gateway-auth";
import { getChannelBalance } from "./balance";
import { resolveChannelToken } from "./mint";
import type { PrivateChannelProjectRpcClient } from "./project-rpc";
import { describeTxError } from "./tx-error";
import { confirmAndPersistWithdrawal } from "./withdraw-confirm";
import { emitWithdrawalEvent } from "./withdraw-events";

/** The instance fields the withdrawal needs. */
type WithdrawalInstance = Pick<
  PrivateChannelInstance,
  "id" | "gatewayUrl" | "escrowProgramId" | "escrowInstanceAddr"
>;

export interface CreateChannelWithdrawalInput {
  instance: WithdrawalInstance;
  organizationId: string;
  projectId: string;
  /** SDP user creating the intent; recorded on the audit context. */
  userId: string;
  /** Custody wallet the burn is signed from (the burn `user` / balance owner). */
  wallet: CustodyWallet;
  /** UI decimal amount (e.g. "1.5"). */
  amount: string;
  /** Mint to withdraw; must be on the instance's allowlist. Defaults to its first entry. */
  mint?: string;
  /**
   * Devnet address that receives the operator's release; already authorized by
   * the route's access seam.
   */
  destination: string;
  /**
   * The caller's `Idempotency-Key`. Required: it is the reservation that makes a
   * retry reuse this withdrawal instead of broadcasting a second burn.
   */
  idempotencyKey: string;
  /**
   * SPC auth context for the gateway. Required — broadcasting the burn is a gateway
   * WRITE and confirming it a gateway READ, both JWT-gated. Resolved by the handler;
   * shared across broadcast + confirm so confirm reuses a token broadcast already
   * refreshed.
   */
  gatewayAuth: SpcAuthContext;
  projectRpc: PrivateChannelProjectRpcClient;
}

/**
 * Build, sign, and broadcast the burn to the gateway. Returns the channel-chain
 * signature. The custody wallet is the sole signer (owner + fee payer).
 */
async function broadcastWithdrawal(
  env: Env,
  input: {
    instance: WithdrawalInstance;
    organizationId: string;
    projectId: string;
    wallet: CustodyWallet;
    mint: Address;
    /** Program owning the mint; seeds the burn's `tokenAccount` derivation. */
    tokenProgram: Address;
    destination: Address;
    amountBaseUnits: bigint;
    gatewayAuth: SpcAuthContext;
  }
): Promise<Signature> {
  // Signer derivation + the (blockhash-independent) burn instruction are built ONCE,
  // outside the retried gateway unit — a 401 retry re-signs against a fresh blockhash
  // but must not re-derive the signer.
  const signer = await solanaServices.createOrgSigner(
    env,
    input.organizationId,
    input.projectId,
    input.wallet.walletId
  );
  if (signer.address !== input.wallet.publicKey) {
    throw badRequest("Resolved signing wallet does not match the withdrawal wallet");
  }

  // `tokenProgram` is passed explicitly rather than left to the generated client's
  // classic-SPL default: it is an ATA seed, so the default would burn from the
  // wrong `tokenAccount` for a token-2022 mint.
  const burnIx = await getWithdrawFundsInstructionAsync({
    user: signer,
    mint: input.mint,
    tokenProgram: input.tokenProgram,
    amount: input.amountBaseUnits,
    destination: input.destination,
  });

  // Blockhash + broadcast on the gateway; whole sequence is the withGatewayRpc retry unit.
  return withGatewayRpc(env, input.instance.gatewayUrl, input.gatewayAuth, async (gatewayRpc) => {
    const { blockhash, lastValidBlockHeight } = await solanaRpc.getRecentBlockhash(
      gatewayRpc,
      "confirmed"
    );

    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(signer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
      (m) => appendTransactionMessageInstructions([burnIx], m)
    );

    const signed = await signTransactionMessageWithSigners(message);
    const signedBytes = new Uint8Array(getTransactionEncoder().encode(signed));
    return solanaRpc.sendTransaction(gatewayRpc, signedBytes);
  });
}

/**
 * Take the reservation for this withdrawal, or hand back the withdrawal that won
 * the race for the same key.
 *
 * The unique index IS the reservation, which is why the insert is allowed to
 * fail: a concurrent duplicate loses it and reads the winner's row rather than
 * broadcasting a second burn, which would destroy balance no later step could
 * give back. The caller has already resolved the sequential-retry case, so this
 * only handles the concurrent one.
 */
async function reserveWithdrawal(
  repo: PrivateChannelWithdrawalRepository,
  fingerprint: string,
  findExisting: () => Promise<PrivateChannelWithdrawalRow | null>,
  input: {
    organizationId: string;
    projectId: string;
    instanceId: string;
    walletId: string;
    owner: string;
    destination: string;
    mint: string;
    amount: string;
    context: PrivateChannelWithdrawalRow["context"];
    idempotencyKey: string;
  }
): Promise<{ row: PrivateChannelWithdrawalRow; replayed: boolean }> {
  try {
    const created = await repo.createWithdrawal({
      ...input,
      idempotencyFingerprint: fingerprint,
    });
    if (!created) {
      throw new AppError("INTERNAL_ERROR", "Failed to persist the withdrawal intent.");
    }
    return { row: created, replayed: false };
  } catch (error) {
    if (!isPostgresUniqueViolation(error)) {
      throw error;
    }
    const raced = await resolveIdempotencyReplay(findExisting, fingerprint);
    if (!raced) {
      throw error;
    }
    return { row: raced, replayed: true };
  }
}

/** Create a withdrawal intent: reserve, check the balance, burn, confirm. */
export async function createChannelWithdrawal(
  env: Env,
  input: CreateChannelWithdrawalInput
): Promise<PrivateChannelWithdrawal> {
  const { instance, organizationId, projectId, wallet } = input;

  const { mint, decimals, tokenProgram } = await resolveChannelToken(
    input.instance,
    input.projectRpc,
    input.mint
  );
  const owner = wallet.publicKey;
  const destination = input.destination;

  const amountBaseUnits = parseDecimalAmount(input.amount, decimals);
  if (amountBaseUnits <= 0n) {
    throw badRequest("amount must be greater than zero");
  }

  const repo = createPrivateChannelWithdrawalRepository(env);
  const findReplay = () =>
    repo.findWithdrawalByIdempotency({
      organizationId,
      projectId,
      idempotencyKey: input.idempotencyKey,
    });
  const fingerprint = buildPrivateChannelWithdrawalFingerprint({
    instanceId: instance.id,
    walletId: wallet.walletId,
    destination,
    mint,
    amount: input.amount,
  });

  // The replay lookup comes FIRST, ahead of the balance read, because a retry of
  // an already-burned withdrawal must return that withdrawal — the balance it
  // spent is gone, so re-checking would reject the caller's own success.
  const replay = await resolveIdempotencyReplay(findReplay, fingerprint);
  if (replay) {
    return mapPrivateChannelWithdrawalRow(replay);
  }

  // Reject an over-withdrawal before it reaches the chain. The burn program would
  // refuse it anyway, but that answer arrives as an opaque channel-chain failure
  // on a row already marked `submitted`; this one is a clean 400 with nothing
  // persisted, and it mirrors the member-transfer path.
  const balance = await getChannelBalance(env, {
    instance,
    owner,
    mint,
    auth: input.gatewayAuth,
    cluster: input.projectRpc.cluster,
  });
  if (amountBaseUnits > BigInt(balance.amount)) {
    throw new AppError("INSUFFICIENT_TOKEN_BALANCE");
  }

  // The reservation is taken BEFORE the signer is derived or the burn is
  // broadcast, so a retry — or a second request racing the first — can only ever
  // reach the row the winner created.
  const { row: created, replayed } = await reserveWithdrawal(repo, fingerprint, findReplay, {
    organizationId,
    projectId,
    instanceId: instance.id,
    walletId: wallet.walletId,
    owner,
    destination,
    mint,
    amount: input.amount,
    // Audit-only snapshot; the oracle always reads the current instance row.
    context: {
      gatewayUrl: instance.gatewayUrl,
      escrowProgramId: instance.escrowProgramId,
      escrowInstanceAddr: instance.escrowInstanceAddr,
      actingUserId: input.userId,
    },
    idempotencyKey: input.idempotencyKey,
  });
  if (replayed) {
    return mapPrivateChannelWithdrawalRow(created);
  }

  let latest: PrivateChannelWithdrawalRow = created;

  // Broadcast the burn. A failure here means the burn never reached the chain (no
  // signature) — a legitimate terminal `failed` (no balance moved). This is the
  // ONLY path to `failed`: once the burn confirms, the balance is authoritatively
  // gone and the oracle escalates unobservable releases via the stuck-warning
  // event instead of auto-failing.
  let signature: Signature;
  try {
    signature = await broadcastWithdrawal(env, {
      instance,
      organizationId,
      projectId,
      wallet,
      mint: address(mint),
      tokenProgram: address(tokenProgram),
      destination: address(destination),
      amountBaseUnits,
      gatewayAuth: input.gatewayAuth,
    });
  } catch (error) {
    const failureReason = describeTxError(error, "Withdrawal submission failed.");
    getLogger().error(
      { withdrawalId: created.id, error },
      "createChannelWithdrawal: broadcast failed"
    );
    const failed = await repo.updateWithdrawal({
      id: created.id,
      status: "failed",
      failureReason,
      expectedStatus: "pending",
    });
    if (failed) {
      await emitWithdrawalEvent(
        env,
        failed,
        PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_WITHDRAWAL_FAILED,
        "failed",
        { failureReason }
      );
    }
    return mapPrivateChannelWithdrawalRow(failed ?? created);
  }

  latest =
    (await repo.updateWithdrawal({
      id: created.id,
      status: "submitted",
      signature,
      expectedStatus: "pending",
    })) ?? latest;

  // Best-effort activity event (never bubbles): burn broadcast.
  await emitWithdrawalEvent(
    env,
    latest,
    PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_WITHDRAWAL_SUBMITTED,
    "pending",
    { signature }
  );

  // Confirm the burn on the gateway. A transport/auth error here leaves the
  // withdrawal `submitted` (the reconciler finalizes it); only a real on-chain
  // burn error marks it `failed`. See `confirmAndPersistWithdrawal`.
  const settled = await confirmAndPersistWithdrawal(env, repo, {
    withdrawalId: created.id,
    gatewayUrl: instance.gatewayUrl,
    signature,
    gatewayAuth: input.gatewayAuth,
  });
  if (settled) {
    latest = settled;
    if (latest.status === "confirmed") {
      await emitWithdrawalEvent(
        env,
        latest,
        PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_WITHDRAWAL_CONFIRMED,
        "confirmed",
        { signature }
      );
    } else if (latest.status === "failed") {
      await emitWithdrawalEvent(
        env,
        latest,
        PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_WITHDRAWAL_FAILED,
        "failed",
        { failureReason: latest.failure_reason }
      );
    }
  }

  return mapPrivateChannelWithdrawalRow(latest);
}

/** Read a single withdrawal for the project. */
export async function getChannelWithdrawal(
  env: Env,
  scope: { organizationId: string; projectId: string; id: string }
): Promise<PrivateChannelWithdrawal | null> {
  const row = await createPrivateChannelWithdrawalRepository(env).getWithdrawalById(scope);
  return row ? mapPrivateChannelWithdrawalRow(row) : null;
}

/** List a project's withdrawals, newest first. */
export async function listChannelWithdrawals(
  env: Env,
  scope: { organizationId: string; projectId: string }
): Promise<PrivateChannelWithdrawal[]> {
  const rows = await createPrivateChannelWithdrawalRepository(env).listWithdrawalsByProject(scope);
  return rows.map(mapPrivateChannelWithdrawalRow);
}
