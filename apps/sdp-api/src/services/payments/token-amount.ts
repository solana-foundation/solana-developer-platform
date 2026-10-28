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
import {
  decodeMint,
  type Extension,
  type ExtensionArgs,
  extension,
  getTokenSize,
  type Mint,
} from "@solana-program/token-2022";
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
  /**
   * The data size of a new associated token account for the mint. A decoded mint answers from the
   * mint already read; a catalogue Token-2022 mint reads its extensions once, on first ask, so
   * conversions of catalogue mints still read nothing.
   */
  readNewTokenAccountSize: () => Promise<number>;
}

const UNSUPPORTED_PAYMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  "InterestBearingConfig",
  // biome-ignore lint/security/noSecrets: Token-2022 extension name, not a secret.
  "ScaledUiAmountConfig",
  "NonTransferable",
]);

/**
 * The account extensions Token-2022 adds to every token account of a mint carrying each mint
 * extension (`required_init_account_extensions`, token-2022 `interface/src/extension/mod.rs`; the
 * kit codec names the program's `Pausable` `PausableConfig`). Kora sizes the ATA rent it charges
 * the same way. Mint extensions absent here require none.
 */
const ACCOUNT_EXTENSIONS_REQUIRED_BY_MINT = [
  {
    mintExtension: "TransferFeeConfig",
    accountExtensions: [extension("TransferFeeAmount", { withheldAmount: 0n })],
  },
  {
    mintExtension: "NonTransferable",
    accountExtensions: [extension("NonTransferableAccount", {}), extension("ImmutableOwner", {})],
  },
  {
    mintExtension: "TransferHook",
    accountExtensions: [extension("TransferHookAccount", { transferring: false })],
  },
  {
    mintExtension: "PausableConfig",
    accountExtensions: [extension("PausableAccount", {})],
  },
] as const satisfies ReadonlyArray<{
  mintExtension: Extension["__kind"];
  accountExtensions: readonly ExtensionArgs[];
}>;

/**
 * The data size of a new associated token account, as the ATA program allocates it: the base
 * account for SPL Token, and for Token-2022 the base account plus `ImmutableOwner` (which the ATA
 * program always requests) and every extension the mint requires on its accounts. That set stays
 * far below the 355-byte multisig length, so Token-2022's multisig padding never applies.
 *
 * @param tokenProgram - The mint's owning token program.
 * @param mintExtensions - The mint's extensions, or null when it has none.
 * @returns The account data size in bytes.
 */
function newTokenAccountSize(tokenProgram: Address, mintExtensions: Extension[] | null): number {
  if (tokenProgram !== SPL_TOKEN_PROGRAMS["token-2022"]) {
    return getTokenSize();
  }
  const mintExtensionKinds = new Set(
    mintExtensions === null ? [] : mintExtensions.map((mintExtension) => mintExtension.__kind)
  );
  const accountExtensions = new Map<ExtensionArgs["__kind"], ExtensionArgs>([
    ["ImmutableOwner", extension("ImmutableOwner", {})],
  ]);
  for (const requirement of ACCOUNT_EXTENSIONS_REQUIRED_BY_MINT) {
    if (!mintExtensionKinds.has(requirement.mintExtension)) continue;
    for (const accountExtension of requirement.accountExtensions) {
      accountExtensions.set(accountExtension.__kind, accountExtension);
    }
  }
  return getTokenSize([...accountExtensions.values()]);
}

/**
 * Reads and decodes a mint account, refusing anything that is not an initialized SPL Token or
 * Token-2022 mint.
 *
 * @param mint - The mint address.
 * @returns The decoded mint.
 * @throws AppError `BAD_REQUEST` for a missing, foreign-owned, malformed or uninitialized mint.
 */
async function decodePaymentMintAccount(mint: Address): Promise<Account<Mint>> {
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
  return decoded;
}

/**
 * Wraps a read so it runs at most once while it succeeds; a failed read is forgotten, so the next
 * ask reads again.
 *
 * @param read - The read to share.
 * @returns A function answering every ask from the one read.
 */
function readOnce(read: () => Promise<number>): () => Promise<number> {
  let pending: Promise<number> | null = null;
  return () => {
    if (pending === null) {
      pending = read().catch((error: unknown) => {
        pending = null;
        throw error;
      });
    }
    return pending;
  };
}

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
 * Records extensions the new-payment admission gate refuses, and sizes a new
 * associated token account from the same decoded extensions.
 * Catalogue facts are verified by check:well-known-mints for the named cluster;
 * other mints are decoded live. The returned facts and converter are reused
 * through funding checks and builds, without another mint or clock read.
 */
async function readPaymentMint(mint: Address): Promise<PaymentMintFacts> {
  const wellKnown = WELL_KNOWN_TOKEN_BY_MINT.get(mint);
  if (wellKnown?.clusters.includes(currentClusterScope().cluster)) {
    const tokenProgram = address(SPL_TOKEN_PROGRAMS[wellKnown.tokenProgram]);
    return {
      refusedExtension: null,
      decimals: wellKnown.decimals,
      tokenProgram,
      toBaseUnits: (amount) => parsePaymentAmount(amount, wellKnown.decimals),
      readNewTokenAccountSize: readOnce(async () =>
        tokenProgram === SPL_TOKEN_PROGRAMS["token-2022"]
          ? newTokenAccountSize(
              tokenProgram,
              unwrapOption((await decodePaymentMintAccount(mint)).data.extensions)
            )
          : getTokenSize()
      ),
    };
  }

  const decoded = await decodePaymentMintAccount(mint);
  const extensions = unwrapOption(decoded.data.extensions);
  const refusedExtension =
    extensions === null
      ? null
      : (extensions.find((extension) => UNSUPPORTED_PAYMENT_EXTENSIONS.has(extension.__kind))
          ?.__kind ?? null);
  const decimals = decoded.data.decimals;
  const tokenAccountSize = newTokenAccountSize(decoded.programAddress, extensions);
  return {
    refusedExtension,
    decimals,
    tokenProgram: decoded.programAddress,
    toBaseUnits: (amount) => parsePaymentAmount(amount, decimals),
    readNewTokenAccountSize: async () => tokenAccountSize,
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
export async function loadPaymentMint(mint: Address): Promise<PaymentMintFacts> {
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
