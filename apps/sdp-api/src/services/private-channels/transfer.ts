import * as solanaRpc from "@sdp/rpc/solana";
import { AmountError, parseDecimalAmount } from "@sdp/solana/amount";
import type { PrivateChannelInstance, PrivateChannelTransfer } from "@sdp/types";
import { PRIVATE_CHANNEL_EVENT_STATUSES, PRIVATE_CHANNEL_EVENT_TYPES } from "@sdp/types";
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
  type TransactionSigner,
} from "@solana/kit";
import { signTransactionMessageWithSigners } from "@solana/signers";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { getTransferCheckedInstruction as getToken2022TransferCheckedInstruction } from "@solana-program/token-2022";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import {
  createPrivateChannelTransferRepository,
  mapPrivateChannelTransferRow,
  type PrivateChannelTransferRepository,
  type PrivateChannelTransferRow,
} from "@/db/repositories";
import { AppError, badRequest } from "@/lib/errors";
import {
  buildPrivateChannelTransferFingerprint,
  resolveIdempotencyReplay,
} from "@/lib/idempotency";
import { getLogger } from "@/runtime/logger";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";
import { type SpcAuthContext, withGatewayRpc } from "./auth/gateway-auth";
import { getChannelBalance } from "./balance";
import { resolveChannelToken } from "./mint";
import { confirmAndPersistTransfer } from "./transfer-confirm";
import { emitTransferEvent } from "./transfer-events";
import { describeTxError, isNodeAtCapacityError } from "./tx-error";

type TransferInstance = Pick<PrivateChannelInstance, "id" | "gatewayUrl">;

export interface CreateChannelTransferInput {
  instance: TransferInstance;
  organizationId: string;
  projectId: string;
  channelId: string;
  /** SDP user initiating the transfer; copied onto every activity event. */
  sdpUserId: string;
  /** The already-resolved SDP custody wallet selected by the acting user. */
  wallet: CustodyWallet;
  /**
   * Signer for `wallet`, derived once by the route's access seam, which also holds
   * it against the member's verified pubkey. Passed in rather than re-derived so a
   * transfer makes one custody-provider round trip instead of two.
   */
  signer: TransactionSigner;
  /** The already-resolved verified wallet of another channel member. */
  recipient: {
    privateChannelUserId: string;
    verifiedWalletId: string;
    pubkey: string;
  };
  amount: string;
  /** Mint to transfer; must be on the instance's allowlist. Defaults to its first entry. */
  mint?: string;
  /**
   * The caller's `Idempotency-Key`. Required: it is the reservation that makes a
   * retry reuse this transfer instead of spending the balance twice.
   */
  idempotencyKey: string;
  gatewayAuth: SpcAuthContext;
  cluster: import("@sdp/types").SolanaCluster;
}

/**
 * Build the ATA-create + transfer pair for a member-to-member channel transfer.
 *
 * `tokenProgram` seeds both ATA derivations, so it must be the program that owns
 * the mint — spl-token and token-2022 derive different addresses for the same
 * (owner, mint) pair.
 *
 * The transfer instruction itself has to branch because `@solana-program/token`'s
 * builders bake their program address into the instruction: there is no
 * `tokenProgram` to override. Classic keeps plain `Transfer` — SPC validates
 * instruction encoding against a program allowlist before queueing (see
 * `./transfer-confirm`), so the one path proven to pass that check stays
 * byte-identical. Token-2022 has no legacy path to preserve and its `Transfer` is
 * deprecated in favour of `TransferChecked`, which is what it gets.
 */
export async function buildTokenTransferInstructions(input: {
  signer: TransactionSigner;
  mint: Address;
  tokenProgram: Address;
  decimals: number;
  recipient: Address;
  amountBaseUnits: bigint;
}) {
  const { tokenProgram } = input;
  const [sourceTokenAccount] = await findAssociatedTokenPda({
    owner: input.signer.address,
    mint: input.mint,
    tokenProgram,
  });
  const [destinationTokenAccount] = await findAssociatedTokenPda({
    owner: input.recipient,
    mint: input.mint,
    tokenProgram,
  });

  const transferInstruction =
    tokenProgram === TOKEN_PROGRAM_ADDRESS
      ? getTransferInstruction({
          source: sourceTokenAccount,
          destination: destinationTokenAccount,
          authority: input.signer,
          amount: input.amountBaseUnits,
        })
      : getToken2022TransferCheckedInstruction({
          source: sourceTokenAccount,
          mint: input.mint,
          destination: destinationTokenAccount,
          authority: input.signer,
          amount: input.amountBaseUnits,
          decimals: input.decimals,
        });

  return {
    sourceTokenAccount,
    destinationTokenAccount,
    instructions: [
      getCreateAssociatedTokenIdempotentInstruction({
        payer: input.signer,
        ata: destinationTokenAccount,
        owner: input.recipient,
        mint: input.mint,
        tokenProgram,
      }),
      transferInstruction,
    ] as const,
  };
}

async function broadcastTransfer(
  env: Env,
  input: {
    instance: TransferInstance;
    signer: TransactionSigner;
    mint: Address;
    /** Program owning the mint; seeds both ATA derivations. */
    tokenProgram: Address;
    decimals: number;
    recipient: Address;
    amountBaseUnits: bigint;
    gatewayAuth: SpcAuthContext;
  }
): Promise<Signature> {
  const signer = input.signer;
  // The (blockhash-independent) instructions are built ONCE, outside the retried
  // gateway unit — a 401 retry re-signs against a fresh blockhash but must not
  // rebuild the instructions.
  const { instructions } = await buildTokenTransferInstructions({
    signer,
    mint: input.mint,
    tokenProgram: input.tokenProgram,
    decimals: input.decimals,
    recipient: input.recipient,
    amountBaseUnits: input.amountBaseUnits,
  });

  // Blockhash + sign + send is ONE withGatewayRpc unit, matching the withdrawal
  // burn. This is load-bearing, not stylistic: SPC's dedup stage silently drops a
  // transaction whose blockhash has left the live window, so the hash must not be
  // allowed to age across a separate round trip. Signing inside the unit also
  // means a 401 retry re-signs against a fresh blockhash and therefore carries a
  // NEW signature — resending identical bytes would be discarded as a duplicate.
  return withGatewayRpc(env, input.instance.gatewayUrl, input.gatewayAuth, async (gatewayRpc) => {
    // SPC accepts and then discards `commitment` (one sequencer, no fork choice),
    // so the level here is inert; it is passed only to match the other SPC paths.
    const { blockhash, lastValidBlockHeight } = await solanaRpc.getRecentBlockhash(
      gatewayRpc,
      "confirmed"
    );
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(signer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
      (m) => appendTransactionMessageInstructions(instructions, m)
    );
    const signed = await signTransactionMessageWithSigners(message);
    const signedBytes = new Uint8Array(getTransactionEncoder().encode(signed));
    return solanaRpc.sendTransaction(gatewayRpc, signedBytes);
  });
}

/**
 * Advance a `pending` row. The CAS guard means a lost race leaves the row alone;
 * the caller falls back to what it already has rather than inventing a result.
 */
async function settleTransfer(
  repo: PrivateChannelTransferRepository,
  pending: PrivateChannelTransferRow,
  outcome:
    | { status: "submitted"; signature: Signature }
    | { status: "failed"; failureReason: string }
): Promise<PrivateChannelTransferRow> {
  try {
    const row = await repo.updateTransfer({
      id: pending.id,
      status: outcome.status,
      signature: outcome.status === "submitted" ? outcome.signature : null,
      failureReason: outcome.status === "failed" ? outcome.failureReason : null,
      expectedStatus: "pending",
    });
    if (row) {
      return row;
    }
    getLogger().error(
      {
        transferId: pending.id,
        status: outcome.status,
      },
      "private-channel-transfer settle found no pending row"
    );
  } catch (error) {
    // The transfer's real outcome is already known; losing the status write only
    // costs accuracy in history, so surface it and leave the row `pending` for an
    // operator rather than failing a request whose funds may have moved.
    getLogger().error(
      {
        transferId: pending.id,
        status: outcome.status,
        error: error instanceof Error ? error.message : error,
      },
      "private-channel-transfer settle failed"
    );
  }
  return pending;
}

/**
 * Take the reservation for this transfer, or hand back the transfer that won the
 * race for the same key. See `reserveWithdrawal` in `./withdraw` — same shape,
 * same reason the insert is allowed to fail.
 */
async function reserveTransfer(
  repo: PrivateChannelTransferRepository,
  fingerprint: string,
  findExisting: () => Promise<PrivateChannelTransferRow | null>,
  input: Omit<
    Parameters<PrivateChannelTransferRepository["createTransfer"]>[0],
    "idempotencyFingerprint"
  >
): Promise<{ row: PrivateChannelTransferRow; replayed: boolean }> {
  try {
    const created = await repo.createTransfer({
      ...input,
      idempotencyFingerprint: fingerprint,
    });
    if (!created) {
      throw new AppError("INTERNAL_ERROR", "Failed to persist the transfer.");
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

/**
 * Persist a `pending` row, send once through SPC, then confirm the result:
 * `pending` → `submitted` → `confirmed` | `failed`.
 *
 * The confirm read is what makes `confirmed` truthful — SPC accepting a submission
 * only means it was queued, and one status read is final because SPC has a single
 * sequencer and no fork choice. See `./transfer-confirm` for the full reasoning and
 * for why a read that never returns a verdict leaves the row `submitted` rather
 * than guessing either way.
 *
 * Anything that fails before or during execution is `failed` and may be retried.
 */
export async function createChannelTransfer(
  env: Env,
  input: CreateChannelTransferInput
): Promise<PrivateChannelTransfer> {
  const token = resolveChannelToken(input.cluster, input.mint);
  const mint = address(token.mint);
  const tokenProgram = address(token.tokenProgram);
  const { decimals } = token;
  let amountBaseUnits: bigint;
  try {
    amountBaseUnits = parseDecimalAmount(input.amount, decimals);
  } catch (error) {
    if (error instanceof AmountError) {
      throw badRequest(error.message);
    }
    throw error;
  }
  if (amountBaseUnits <= 0n) {
    throw badRequest("amount must be greater than zero");
  }

  const sender = address(input.wallet.publicKey);
  const recipientAddress = address(input.recipient.pubkey);

  const repo = createPrivateChannelTransferRepository(env);
  const findReplay = () =>
    repo.findTransferByIdempotency({
      organizationId: input.organizationId,
      projectId: input.projectId,
      idempotencyKey: input.idempotencyKey,
    });
  const fingerprint = buildPrivateChannelTransferFingerprint({
    instanceId: input.instance.id,
    channelId: input.channelId,
    walletId: input.wallet.walletId,
    recipientVerifiedWalletId: input.recipient.verifiedWalletId,
    mint,
    amount: input.amount,
  });

  // The replay lookup comes FIRST, ahead of the balance read, because a retry of
  // an already-executed transfer must return that transfer — the balance it spent
  // is gone, so re-checking would reject the caller's own success.
  const replay = await resolveIdempotencyReplay(findReplay, fingerprint);
  if (replay) {
    return mapPrivateChannelTransferRow(replay);
  }

  const balance = await getChannelBalance(env, {
    instance: input.instance,
    owner: sender,
    mint,
    auth: input.gatewayAuth,
    cluster: input.cluster,
  });
  if (amountBaseUnits > BigInt(balance.amount)) {
    throw new AppError("INSUFFICIENT_TOKEN_BALANCE");
  }

  // Persist BEFORE anything is broadcast, so a request that dies mid-flight still
  // leaves an auditable row. The insert doubles as the reservation: the unique
  // index on (organization, project, idempotency_key) means a duplicate racing
  // this one loses and replays instead of spending the balance a second time.
  const reserved = await reserveTransfer(repo, fingerprint, findReplay, {
    organizationId: input.organizationId,
    projectId: input.projectId,
    instanceId: input.instance.id,
    channelId: input.channelId,
    senderPrivateChannelUserId: input.gatewayAuth.pcUserId,
    recipientPrivateChannelUserId: input.recipient.privateChannelUserId,
    senderWalletId: input.wallet.walletId,
    recipientVerifiedWalletId: input.recipient.verifiedWalletId,
    sender,
    recipient: recipientAddress,
    mint,
    amount: input.amount,
    idempotencyKey: input.idempotencyKey,
  });
  if (reserved.replayed) {
    return mapPrivateChannelTransferRow(reserved.row);
  }
  const pending = reserved.row;

  const fail = async (failureReason: string) => {
    const failed = await settleTransfer(repo, pending, { status: "failed", failureReason });
    await emitTransferEvent(
      env,
      failed,
      PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_TRANSFER_FAILED,
      PRIVATE_CHANNEL_EVENT_STATUSES.FAILED,
      input.sdpUserId
    );
    return mapPrivateChannelTransferRow(failed);
  };

  let signature: Signature;
  try {
    signature = await broadcastTransfer(env, {
      instance: input.instance,
      signer: input.signer,
      mint,
      tokenProgram,
      decimals,
      recipient: recipientAddress,
      amountBaseUnits,
      gatewayAuth: input.gatewayAuth,
    });
  } catch (error) {
    // A capacity shed happens at ingress before the dedup insert, so nothing was
    // queued and the same transfer is immediately retryable. Say so, instead of
    // filing it as if SPC had rejected the transfer itself.
    if (isNodeAtCapacityError(error)) {
      return fail("SPC is at capacity and did not accept the transfer. Try again shortly.");
    }
    return fail(describeTxError(error, "Transfer submission failed."));
  }

  let latest = await settleTransfer(repo, pending, { status: "submitted", signature });
  // `pending`: SPC has accepted the transaction but not yet executed it, so the
  // event must not claim more than the row does.
  await emitTransferEvent(
    env,
    latest,
    PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_TRANSFER_SUBMITTED,
    PRIVATE_CHANNEL_EVENT_STATUSES.PENDING,
    input.sdpUserId
  );

  const settled = await confirmAndPersistTransfer(env, repo, {
    transferId: pending.id,
    gatewayUrl: input.instance.gatewayUrl,
    signature,
    gatewayAuth: input.gatewayAuth,
  });
  if (settled) {
    latest = settled;
    if (latest.status === "confirmed") {
      await emitTransferEvent(
        env,
        latest,
        PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_TRANSFER_CONFIRMED,
        PRIVATE_CHANNEL_EVENT_STATUSES.CONFIRMED,
        input.sdpUserId
      );
    } else if (latest.status === "failed") {
      await emitTransferEvent(
        env,
        latest,
        PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_TRANSFER_FAILED,
        PRIVATE_CHANNEL_EVENT_STATUSES.FAILED,
        input.sdpUserId
      );
    }
  }

  return mapPrivateChannelTransferRow(latest);
}
