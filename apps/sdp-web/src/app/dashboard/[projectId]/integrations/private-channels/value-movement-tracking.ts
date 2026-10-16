"use client";

import { createIdempotencyKeyStore } from "@/lib/idempotency-key-store";

/**
 * Idempotency-key stores for the three Private Channels value movements.
 *
 * All three API routes now REQUIRE an `Idempotency-Key`, because each of them
 * signs and broadcasts: a deposit moves real USDC into the instance escrow, a
 * withdrawal burns channel balance irreversibly, and a member transfer spends
 * it. The key has to be minted here rather than in the server action — an action
 * runs once per invocation, so a key it generated would be fresh on every retry,
 * which is the definition of a second movement.
 *
 * Durability, expiry, quota fallback and the retire rule all come from
 * `@/lib/idempotency-key-store.ts`, shared with the Earn vault flows. One store
 * per movement so a deposit and a withdrawal of the same amount from the same
 * wallet can never collide into one fingerprint.
 */
export const privateChannelDepositIdempotencyKeyStore = createIdempotencyKeyStore(
  "sdp:private-channels:deposit:idempotency:v1"
);

export const privateChannelWithdrawalIdempotencyKeyStore = createIdempotencyKeyStore(
  "sdp:private-channels:withdrawal:idempotency:v1"
);

export const privateChannelTransferIdempotencyKeyStore = createIdempotencyKeyStore(
  "sdp:private-channels:transfer:idempotency:v1"
);

/**
 * What makes two submissions the SAME deposit: the source wallet, the mint, the
 * amount, and the credited recipient. These are exactly the fields the API
 * fingerprints the reservation on, which is the property that matters — a client
 * fingerprint coarser than the server's would reuse a key the server then
 * rejects as a 409, and a finer one would mint a new key for a request the
 * server considers identical and let it move funds twice.
 */
export function privateChannelDepositRequestFingerprint(input: {
  walletId: string;
  mint: string | undefined;
  amount: string;
  recipient: string | undefined;
}): string {
  return JSON.stringify([
    "deposit",
    input.walletId,
    input.mint ?? null,
    input.amount,
    input.recipient ?? null,
  ]);
}

/** The withdrawal's mirror; `destination` is what the release is paid to. */
export function privateChannelWithdrawalRequestFingerprint(input: {
  walletId: string;
  mint: string | undefined;
  amount: string;
  destination: string | undefined;
}): string {
  return JSON.stringify([
    "withdrawal",
    input.walletId,
    input.mint ?? null,
    input.amount,
    input.destination ?? null,
  ]);
}

/**
 * The member transfer's. The recipient is named by its opaque verified-wallet
 * id, which is the only recipient handle this flow ever holds.
 */
export function privateChannelTransferRequestFingerprint(input: {
  channelId: string;
  walletId: string;
  recipientVerifiedWalletId: string;
  mint: string | undefined;
  amount: string;
}): string {
  return JSON.stringify([
    "transfer",
    input.channelId,
    input.walletId,
    input.recipientVerifiedWalletId,
    input.mint ?? null,
    input.amount,
  ]);
}
