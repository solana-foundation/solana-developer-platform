/**
 * The mint checks that need chain state, done before a trade is signed.
 *
 * `validateDvpTerms` deliberately covers only the rules judgeable from the
 * payload, and its own header says the account-reading ones are "handled where
 * the trade is built". This is that place. Until now it was nowhere: a trade on
 * a mint the program refuses got signed, recorded and broadcast, and came back
 * as a raw `custom program error: 0xa` — after we had already spent a signature
 * and written a row.
 *
 * Two checks, both reading the mint account:
 *
 * 1. The mint is owned by the token program the caller named. Nothing else
 *    verifies this, and it is not cosmetic: the escrow ATA derives from
 *    (swapDvp, mint, tokenProgram), so a wrong program yields an address the
 *    program will not accept — and that address is the one we would publish for
 *    a counterparty to pay into.
 *
 * 2. The mint carries none of the four extensions the program refuses.
 */

import { getAccountInfo, type SolanaRpc } from "@sdp/rpc/solana";
import type { Address } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { getMintDecoder, TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";

/**
 * Extensions `validate_mint_extensions` rejects with `BlockedMintExtension`
 * (`program/src/processor/shared/token_utils.rs:340-346`), at CreateDvp and at
 * SettleDvp alike.
 *
 * Two distinct reasons, kept apart because they say different things to a user:
 * the first three mutate amounts, so the credited amount drifts from the
 * debited one and a leg settles short; `NonTransferable` blocks transfers out
 * of the escrow, so anything that lands there is stranded with no settle,
 * refund or reclaim.
 *
 * Everything else is allowed — including `PermanentDelegate`,
 * `DefaultAccountState`, `TransferHook` and `Pausable`.
 */
const BLOCKED_MINT_EXTENSIONS: ReadonlySet<string> = new Set([
  "TransferFeeConfig",
  "InterestBearingConfig",
  // biome-ignore lint/security/noSecrets: Token-2022 extension name, not a secret.
  "ScaledUiAmountConfig",
  "NonTransferable",
]);

/** The two token programs a DvP leg may use. */
const SUPPORTED_TOKEN_PROGRAMS: ReadonlySet<string> = new Set([
  TOKEN_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
]);

export interface DvpMintLeg {
  /** "mintA" or "mintB" — used only to name the offending field in the error. */
  label: string;
  mint: Address;
  tokenProgram: Address;
}

/**
 * Reads both legs' mints and returns every problem, empty when they are sound.
 *
 * Reports all problems rather than the first, so a caller fixes one payload
 * instead of discovering the next failure on the next request — same contract
 * as `validateDvpTerms`.
 *
 * @param rpc - Solana RPC to read the mints from.
 * @param legs - The mint and declared token program of each leg.
 * @returns Human-readable problems, empty when the mints are acceptable.
 */
export async function validateDvpMints(
  rpc: SolanaRpc,
  legs: readonly DvpMintLeg[]
): Promise<string[]> {
  const problems: string[] = [];

  const accounts = await Promise.all(legs.map((leg) => getAccountInfo(rpc, leg.mint)));

  for (const [index, leg] of legs.entries()) {
    if (!SUPPORTED_TOKEN_PROGRAMS.has(leg.tokenProgram)) {
      problems.push(`${leg.label} token program ${leg.tokenProgram} is not an SPL token program`);
      continue;
    }

    const account = accounts[index];
    if (!account) {
      problems.push(`${leg.label} ${leg.mint} does not exist on this cluster`);
      continue;
    }

    // The owner IS the token program. Trusting the caller's declared program
    // over the account's actual owner is what would publish an escrow address
    // derived under the wrong program.
    if (account.owner !== leg.tokenProgram) {
      problems.push(
        `${leg.label} ${leg.mint} is owned by ${account.owner}, not the declared token program ${leg.tokenProgram}`
      );
      continue;
    }

    // Only Token-2022 mints carry extensions; a legacy mint has none by
    // construction, so there is nothing to inspect.
    if (leg.tokenProgram !== TOKEN_2022_PROGRAM_ADDRESS) {
      continue;
    }

    const blocked = readBlockedExtensions(account.data);
    for (const extension of blocked) {
      problems.push(
        `${leg.label} ${leg.mint} carries the ${extension} extension, which DvP settlement refuses`
      );
    }
  }

  return problems;
}

/**
 * A mint's decimals, or null when it cannot be read.
 *
 * `TransferChecked` takes decimals and the token program verifies them against
 * the mint, so passing a guess would fail the transfer rather than move a wrong
 * quantity — but reading them is still the only way to send at all.
 */
export async function readMintDecimals(rpc: SolanaRpc, mint: Address): Promise<number | null> {
  const account = await getAccountInfo(rpc, mint);
  if (!account) {
    return null;
  }
  const bytes = toBytes(account.data);
  if (!bytes) {
    return null;
  }
  try {
    return getMintDecoder().decode(bytes).decimals;
  } catch {
    return null;
  }
}

/**
 * Names the deny-listed extensions present on a mint's raw account data.
 *
 * Returns nothing on data it cannot parse rather than throwing. This is a
 * pre-flight whose only job is to turn a would-be on-chain failure into a
 * useful 400; if it cannot read the mint, the program still enforces the same
 * rule and the trade fails there instead. Refusing a trade because our parser
 * tripped would be worse than the round trip we are saving.
 */
function readBlockedExtensions(data: unknown): string[] {
  const bytes = toBytes(data);
  if (!bytes) {
    return [];
  }
  try {
    const mint = getMintDecoder().decode(bytes);
    const extensions = mint.extensions.__option === "Some" ? mint.extensions.value : [];
    return extensions
      .map((extension) => extension.__kind)
      .filter((kind) => BLOCKED_MINT_EXTENSIONS.has(kind));
  } catch {
    return [];
  }
}

/** `getAccountInfo` returns base64-encoded data as a `[data, encoding]` pair. */
function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (Array.isArray(data) && typeof data[0] === "string") {
    return Uint8Array.from(Buffer.from(data[0], "base64"));
  }
  return null;
}
