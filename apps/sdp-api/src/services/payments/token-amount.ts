import { createClusterRpc } from "@sdp/rpc/factory";
import { type ClusterScope, currentClusterScope } from "@sdp/rpc/scope";
import { AmountError, parseTokenAmount } from "@sdp/solana/amount";
import { SPL_TOKEN_PROGRAMS, WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types/well-known-tokens";
import {
  type Account,
  type Address,
  address,
  fetchEncodedAccount,
  unwrapOption,
} from "@solana/kit";
import { decodeMint, type Mint } from "@solana-program/token-2022";
import { badRequest } from "@/lib/errors";

/** An exact decimal-string to u64 base-unit conversion. */
export type PaymentAmountConverter = (amount: string) => bigint;

export interface PaymentMint {
  decimals: number;
  tokenProgram: Address;
  toBaseUnits: PaymentAmountConverter;
}

const UNSUPPORTED_PAYMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  "InterestBearingConfig",
  // biome-ignore lint/security/noSecrets: Token-2022 extension name, not a secret.
  "ScaledUiAmountConfig",
  "NonTransferable",
]);

/** Maps invalid precision or a value outside u64 to a client error, without rounding. */
function parsePaymentAmount(amount: string, decimals: number): bigint {
  try {
    return parseTokenAmount(amount, decimals);
  } catch (error) {
    if (error instanceof AmountError) throw badRequest(error.message);
    throw error;
  }
}

/**
 * Resolves the mint's actual decimals and owning token program in one read.
 * Refuses extensions that change the requested amount or prevent transfer.
 * Catalogue facts are verified by check:well-known-mints for the named cluster;
 * other mints are decoded live. The returned facts and converter are reused
 * through funding checks and builds, without another mint or clock read.
 */
async function readPaymentMint(mint: Address): Promise<PaymentMint> {
  const wellKnown = WELL_KNOWN_TOKEN_BY_MINT.get(mint);
  if (wellKnown?.clusters.includes(currentClusterScope().cluster)) {
    return {
      decimals: wellKnown.decimals,
      tokenProgram: address(SPL_TOKEN_PROGRAMS[wellKnown.tokenProgram]),
      toBaseUnits: (amount) => parsePaymentAmount(amount, wellKnown.decimals),
    };
  }

  const account = await fetchEncodedAccount(createClusterRpc(), mint, { commitment: "confirmed" });
  if (!account.exists) throw badRequest("Token mint account does not exist");
  if (
    account.programAddress !== SPL_TOKEN_PROGRAMS["spl-token"] &&
    account.programAddress !== SPL_TOKEN_PROGRAMS["token-2022"]
  ) {
    throw badRequest("Unsupported token program for mint");
  }
  // Legacy and Token-2022 mints share the base layout; the decoder also reads extensions.
  let decoded: Account<Mint>;
  try {
    decoded = decodeMint(account);
  } catch {
    throw badRequest("Token mint account data is invalid");
  }
  if (!decoded.data.isInitialized) throw badRequest("Token mint is not initialized");
  const extensions = unwrapOption(decoded.data.extensions);
  if (extensions !== null) {
    for (const extension of extensions) {
      if (UNSUPPORTED_PAYMENT_EXTENSIONS.has(extension.__kind)) {
        throw badRequest(`Payments do not support the ${extension.__kind} mint extension`);
      }
    }
  }
  const decimals = decoded.data.decimals;
  return {
    decimals,
    tokenProgram: account.programAddress,
    toBaseUnits: (amount) => parsePaymentAmount(amount, decimals),
  };
}

// Share immutable mint facts only within this request or cron scope. A failed
// lookup is removed, and a later scope always reads custom mints afresh.
const scopedMints = new WeakMap<ClusterScope, Map<Address, Promise<PaymentMint>>>();

export function loadPaymentMint(mint: Address): Promise<PaymentMint> {
  const scope = currentClusterScope();
  let mints = scopedMints.get(scope);
  if (mints === undefined) {
    mints = new Map();
    scopedMints.set(scope, mints);
  }
  const pending = mints.get(mint);
  if (pending !== undefined) return pending;
  const entries = mints;
  const lookup = readPaymentMint(mint).catch((error: unknown) => {
    entries.delete(mint);
    throw error;
  });
  entries.set(mint, lookup);
  return lookup;
}

/** Resolves a mint once for a batch of exact conversions. */
export async function loadPaymentAmountConverter(mint: Address): Promise<PaymentAmountConverter> {
  return (await loadPaymentMint(mint)).toBaseUnits;
}

/** Recurring and subscription amounts use the same admissible mints as single payments. */
export async function readStaticAmountMintDecimals(mint: Address): Promise<number> {
  return (await loadPaymentMint(mint)).decimals;
}

/** Validates a payment's precision before a create path persists it. */
export async function assertPaymentAmountFitsMint(amount: string, mint: Address): Promise<void> {
  (await loadPaymentMint(mint)).toBaseUnits(amount);
}

/** Parses recurring and subscription terms with the same strict payment rules. */
export async function parseStaticPaymentAmount(amount: string, mint: Address): Promise<bigint> {
  return (await loadPaymentMint(mint)).toBaseUnits(amount);
}
