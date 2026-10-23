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

export interface PaymentMintFacts extends PaymentMint {
  refusedExtension: string | null;
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
 * Records extensions the new-payment admission gate refuses.
 * Catalogue facts are verified by check:well-known-mints for the named cluster;
 * other mints are decoded live. The returned facts and converter are reused
 * through funding checks and builds, without another mint or clock read.
 */
async function readPaymentMint(mint: Address): Promise<PaymentMintFacts> {
  const wellKnown = WELL_KNOWN_TOKEN_BY_MINT.get(mint);
  if (wellKnown?.clusters.includes(currentClusterScope().cluster)) {
    return {
      refusedExtension: null,
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
  const refusedExtension =
    extensions === null
      ? null
      : (extensions.find((extension) => UNSUPPORTED_PAYMENT_EXTENSIONS.has(extension.__kind))
          ?.__kind ?? null);
  const decimals = decoded.data.decimals;
  return {
    refusedExtension,
    decimals,
    tokenProgram: account.programAddress,
    toBaseUnits: (amount) => parsePaymentAmount(amount, decimals),
  };
}

// Share immutable mint facts only within this request or cron scope. A failed
// lookup is removed, and a later scope always reads custom mints afresh.
const scopedMints = new WeakMap<ClusterScope, Map<Address, Promise<PaymentMintFacts>>>();

/** Reads mint facts for proof/recovery without admitting a new payment. */
export function loadPaymentMintFacts(mint: Address): Promise<PaymentMintFacts> {
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

/** Admits new money movement after resolving the mint facts. */
export async function loadPaymentMint(mint: Address): Promise<PaymentMint> {
  const facts = await loadPaymentMintFacts(mint);
  if (facts.refusedExtension !== null)
    throw badRequest(`Payments do not support the ${facts.refusedExtension} mint extension`);
  return facts;
}

/** Resolves a mint once for a batch of exact conversions. */
export async function loadPaymentAmountConverter(mint: Address): Promise<PaymentAmountConverter> {
  return (await loadPaymentMint(mint)).toBaseUnits;
}

/**
 * Parses a payment amount against an admissible mint's precision and the u64 range, so a create
 * path refuses an amount it could never send before it persists anything.
 *
 * @param amount - The decimal UI amount from the request.
 * @param mint - The payment's SPL mint, or the SOL mint.
 * @returns The amount in the mint's base units.
 * @throws AppError `BAD_REQUEST` for a refused mint, excess precision or a value outside u64.
 */
export async function parseStaticPaymentAmount(amount: string, mint: Address): Promise<bigint> {
  return (await loadPaymentMint(mint)).toBaseUnits(amount);
}
