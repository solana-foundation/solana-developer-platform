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
import {
  createPrivateChannelTransferRepository,
  mapPrivateChannelTransferRow,
  type PrivateChannelTransferRepository,
  type PrivateChannelTransferRow,
} from "@/db/repositories";
import { AppError, badRequest } from "@/lib/errors";
import { getLogger } from "@/runtime/logger";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";
import { type SpcAuthContext, withGatewayRpc } from "./auth/gateway-auth";
import { getChannelBalance } from "./balance";
import { inferCluster, resolveChannelToken } from "./mint";
import { confirmAndPersistTransfer } from "./transfer-confirm";
import { emitTransferEvent } from "./transfer-events";
import { describeTxError, isNodeAtCapacityError } from "./tx-error";

type TransferInstance = Pick<PrivateChannelInstance, "id" | "gatewayUrl" | "chainRpcUrl">;

export interface CreateChannelTransferInput {
  instance: TransferInstance;
  organizationId: string;
  projectId: string;
  channelId: string;
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
  gatewayAuth: SpcAuthContext;
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
  const cluster = inferCluster(input.instance.chainRpcUrl);
  const token = resolveChannelToken(cluster, input.mint);
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
  const balance = await getChannelBalance(env, {
    instance: input.instance,
    owner: sender,
    mint,
    auth: input.gatewayAuth,
  });
  if (amountBaseUnits > BigInt(balance.amount)) {
    throw new AppError("INSUFFICIENT_TOKEN_BALANCE");
  }

  // Persist BEFORE anything is broadcast, so a request that dies mid-flight still
  // leaves an auditable row. A failure here means nothing was sent, which is a
  // legitimate 500 — there is no funds movement to report.
  const repo = createPrivateChannelTransferRepository(env);
  const pending = await repo.createTransfer({
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
  });
  if (!pending) {
    throw new AppError("INTERNAL_ERROR", "Failed to persist the transfer.");
  }

  const fail = async (failureReason: string) => {
    const failed = await settleTransfer(repo, pending, { status: "failed", failureReason });
    await emitTransferEvent(
      env,
      failed,
      PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_TRANSFER_FAILED,
      PRIVATE_CHANNEL_EVENT_STATUSES.FAILED
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
    PRIVATE_CHANNEL_EVENT_STATUSES.PENDING
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
        PRIVATE_CHANNEL_EVENT_STATUSES.CONFIRMED
      );
    } else if (latest.status === "failed") {
      await emitTransferEvent(
        env,
        latest,
        PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_TRANSFER_FAILED,
        PRIVATE_CHANNEL_EVENT_STATUSES.FAILED
      );
    }
  }

  return mapPrivateChannelTransferRow(latest);
}
