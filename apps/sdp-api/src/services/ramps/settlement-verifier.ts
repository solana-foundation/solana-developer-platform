import { getSolanaConfig } from "@sdp/rpc";
import { parseDecimalAmount } from "@sdp/solana/amount";
import { isWellKnownTokenSymbol, type SolanaCluster, wellKnownMint } from "@sdp/types";
import type { PaymentTransferRow } from "@/db/repositories";
import {
  fetchParsedTransaction,
  type RpcTokenBalanceRecord,
} from "@/routes/payments/handlers/observed-transfers";
import type { Env } from "@/types/env";

/**
 * The outcome of checking one provider-reported settlement signature against the chain (#559).
 *
 * Only `verified: true` may ever mark a transfer as proven, and it is reachable from exactly one
 * path: a transaction that exists, succeeded, and moved at least the expected amount of the
 * expected mint to or from this transfer's own wallet. Every other path, including every error,
 * returns not-verified with a reason. A false `pending` is visible and recoverable; a false
 * `verified` is a silent claim that money moved.
 */
export type RampVerificationOutcome =
  | { verified: true; slot: number; method: "provider_signature" }
  | { verified: false; reason: string };

/**
 * Tolerance between our clock (`created_at`) and validator-reported cluster time (`blockTime`).
 * One-sided and generous: the set being excluded is the wallet's entire history before the order
 * existed, so widening it by minutes costs nothing.
 */
const CLOCK_SKEW_SECONDS = 300;

function notVerified(reason: string): RampVerificationOutcome {
  return { verified: false, reason };
}

/**
 * Resolve the mint this transfer is denominated in.
 *
 * Ramp rows observed in practice store the mint address, not the symbol, even though the quote
 * request takes a symbol (`cryptoToken: "USDC"`). The symbol branch is kept because that
 * conversion happens upstream and is not guaranteed, so both shapes can reach here.
 *
 * Returning null is a refusal, not a default: verifying against an unknown mint would accept a
 * transfer of the wrong asset.
 */
function resolveExpectedMint(token: string, cluster: SolanaCluster): string | null {
  if (isWellKnownTokenSymbol(token)) {
    return wellKnownMint(token, cluster) ?? null;
  }
  // Not in the catalogue. A base58 address is plausible; anything else is not resolvable.
  return token.length >= 32 && token.length <= 44 ? token : null;
}

function rawBalanceFor(
  balances: readonly RpcTokenBalanceRecord[],
  owner: string,
  mint: string
): bigint {
  let total = 0n;
  for (const balance of balances) {
    if (balance.owner !== owner || balance.mint !== mint) {
      continue;
    }
    const amount = balance.uiTokenAmount?.amount;
    if (typeof amount === "string" && /^\d+$/.test(amount)) {
      total += BigInt(amount);
    }
  }
  return total;
}

function decimalsFor(
  balances: readonly RpcTokenBalanceRecord[],
  owner: string,
  mint: string
): number | null {
  for (const balance of balances) {
    if (balance.owner === owner && balance.mint === mint) {
      const decimals = balance.uiTokenAmount?.decimals;
      if (typeof decimals === "number" && Number.isInteger(decimals) && decimals >= 0) {
        return decimals;
      }
    }
  }
  return null;
}

/**
 * Prove, or fail to prove, that a ramp transfer's settlement actually happened on chain.
 *
 * The provider-supplied signature is treated as a lookup key and never as evidence: a provider
 * could report a real transaction that has nothing to do with this transfer, so the transaction's
 * contents are what decide the outcome.
 */
export async function verifyRampSettlement(
  env: Env,
  transfer: PaymentTransferRow
): Promise<RampVerificationOutcome> {
  const signature = transfer.settlement_signature;
  if (!signature) {
    return notVerified("no settlement signature recorded");
  }
  if (!transfer.amount) {
    return notVerified("transfer has no amount to verify against");
  }

  // On-ramps deliver into the destination wallet; off-ramps send out of the source wallet.
  // Either way the address comes from the transfer row, never from the webhook, so a provider
  // cannot point verification at a wallet belonging to someone else.
  const isOnramp = transfer.type === "onramp";
  const expectedOwner = isOnramp ? transfer.destination_address : transfer.source_address;
  if (!expectedOwner) {
    return notVerified(`transfer has no ${isOnramp ? "destination" : "source"} address`);
  }

  const cluster = getSolanaConfig(env).network as SolanaCluster;
  const expectedMint = resolveExpectedMint(transfer.token, cluster);
  if (!expectedMint) {
    return notVerified(`cannot resolve a mint for token ${transfer.token} on ${cluster}`);
  }

  let parsed: Awaited<ReturnType<typeof fetchParsedTransaction>>;
  try {
    parsed = await fetchParsedTransaction(env, signature);
  } catch (error) {
    // An RPC failure says nothing about whether the money moved, so the row stays unproven
    // and is polled again rather than being resolved either way.
    return notVerified(`rpc lookup failed: ${error instanceof Error ? error.message : "unknown"}`);
  }

  if (!parsed) {
    return notVerified("transaction not found on chain");
  }
  if (parsed.meta?.err != null) {
    return notVerified("transaction failed on chain");
  }

  // A transaction that predates the order cannot be its settlement. Missing block time refuses
  // rather than passes: absent evidence is not evidence.
  const blockTime = typeof parsed.blockTime === "number" ? parsed.blockTime : null;
  if (blockTime === null) {
    return notVerified("transaction has no block time");
  }
  const createdAtMs = Date.parse(transfer.created_at);
  if (!Number.isFinite(createdAtMs)) {
    return notVerified(`transfer created_at is not a parseable date: ${transfer.created_at}`);
  }
  if (blockTime < Math.floor(createdAtMs / 1000) - CLOCK_SKEW_SECONDS) {
    return notVerified(
      `transaction block time ${blockTime} predates the transfer created at ${transfer.created_at}`
    );
  }

  const pre = parsed.meta?.preTokenBalances ?? [];
  const post = parsed.meta?.postTokenBalances ?? [];
  const decimals =
    decimalsFor(post, expectedOwner, expectedMint) ?? decimalsFor(pre, expectedOwner, expectedMint);
  if (decimals === null) {
    return notVerified("transaction does not touch the expected wallet and mint");
  }

  const delta =
    rawBalanceFor(post, expectedOwner, expectedMint) -
    rawBalanceFor(pre, expectedOwner, expectedMint);
  // An on-ramp must credit the destination; an off-ramp must debit the source. Comparing the
  // signed movement rather than its magnitude stops a transfer in the wrong direction passing.
  const moved = isOnramp ? delta : -delta;

  let expectedRaw: bigint;
  try {
    expectedRaw = parseDecimalAmount(transfer.amount, decimals);
  } catch {
    return notVerified(`amount ${transfer.amount} is not representable at ${decimals} decimals`);
  }

  // Exact, not "at least". An at-least bound lets any larger unrelated movement through, and a
  // tolerance band is a free parameter an attacker sizes their transfer to fit inside. If evidence
  // of a legitimate mismatch ever appears, tolerance may only be added on the LOW side
  // (expectedRaw - tolerance <= moved <= expectedRaw), never the high: moving MORE than expected is
  // the case being excluded. Both numbers are printed so the first real mismatch diagnoses itself.
  //
  // Two on-ramps batched into one transaction fail this for both rows. That is already unsupported
  // by the ramp-scoped unique index on settlement_signature; exact matching makes it fail loudly
  // instead of verifying an arbitrary one of them.
  if (moved < expectedRaw) {
    return notVerified(
      `moved ${moved.toString()} base units, expected exactly ${expectedRaw.toString()}`
    );
  }
  if (moved > expectedRaw) {
    return notVerified(
      `moved ${moved.toString()} base units, more than the expected ${expectedRaw.toString()}`
    );
  }

  const slot = typeof parsed.slot === "number" ? parsed.slot : Number(parsed.slot ?? 0);
  if (!Number.isFinite(slot) || slot <= 0) {
    return notVerified("transaction has no usable slot");
  }

  return { verified: true, slot, method: "provider_signature" };
}
