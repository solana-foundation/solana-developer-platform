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
 *
 * 3. The mint carries no extension SDP cannot move yet, even where the program
 *    accepts it. A trade SDP can create but never settle, cancel or reclaim is
 *    a trap for whoever funds it.
 */

import type { SolanaRpc } from "@sdp/rpc/solana";
import { type Account, type Address, type EncodedAccount, fetchEncodedAccount } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  decodeMint,
  fetchMaybeMint,
  type Mint,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@solana-program/token-2022";

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
 * Everything else passes the program, including `PermanentDelegate`,
 * `DefaultAccountState`, `TransferHook` and `Pausable`. See
 * `UNSUPPORTED_MINT_EXTENSIONS` for what SDP refuses on top.
 */
export const BLOCKED_MINT_EXTENSIONS: ReadonlySet<string> = new Set([
  "TransferFeeConfig",
  "InterestBearingConfig",
  // biome-ignore lint/security/noSecrets: Token-2022 extension name, not a secret.
  "ScaledUiAmountConfig",
  "NonTransferable",
]);

/**
 * Extensions the program accepts that SDP cannot move yet, so it refuses them
 * before a trade exists.
 *
 * `TransferHook`: every transfer out of an escrow (settle, cancel, reclaim) runs
 * the mint's hook, and the program forwards the hook's extra accounts as
 * trailing accounts on the instruction. SDP does not resolve those accounts, so
 * the token program refuses each of those transfers. Accepting the mint at
 * create would leave a funded leg with no way out.
 */
export const UNSUPPORTED_MINT_EXTENSIONS: ReadonlySet<string> = new Set(["TransferHook"]);

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

  // Encoded fetch, not `fetchMaybeMint`: that decodes eagerly, so bytes that are
  // not a mint would throw before the owner check ran — turning "you pasted a
  // non-mint address" from a named 400 into a 500. Existence and ownership are
  // judged on the raw account; decoding happens only for the extensions check.
  const accounts = await Promise.all(legs.map((leg) => fetchEncodedAccount(rpc, leg.mint)));

  for (const [index, leg] of legs.entries()) {
    if (!SUPPORTED_TOKEN_PROGRAMS.has(leg.tokenProgram)) {
      problems.push(`${leg.label} token program ${leg.tokenProgram} is not an SPL token program`);
      continue;
    }

    const account = accounts[index];
    if (!account.exists) {
      problems.push(`${leg.label} ${leg.mint} does not exist on this cluster`);
      continue;
    }

    // The owner IS the token program. Trusting the caller's declared program
    // over the account's actual owner is what would publish an escrow address
    // derived under the wrong program.
    if (account.programAddress !== leg.tokenProgram) {
      problems.push(
        `${leg.label} ${leg.mint} is owned by ${account.programAddress}, not the declared token program ${leg.tokenProgram}`
      );
      continue;
    }

    // Only Token-2022 mints carry extensions; a legacy mint has none by
    // construction, so there is nothing to inspect.
    if (leg.tokenProgram !== TOKEN_2022_PROGRAM_ADDRESS) {
      continue;
    }

    const extensionProblems = readMintExtensionProblems(account);
    if (extensionProblems === null) {
      // The program would still refuse its own four, but it accepts a transfer
      // hook, so a mint SDP cannot read is one it cannot rule a hook out of.
      problems.push(
        `${leg.label} ${leg.mint} has extension data SDP cannot read, so it cannot confirm the mint is settleable`
      );
      continue;
    }
    const { refusedByProgram, unsupportedBySdp } = extensionProblems;
    for (const extension of refusedByProgram) {
      problems.push(
        `${leg.label} ${leg.mint} carries the ${extension} extension, which DvP settlement refuses`
      );
    }
    for (const extension of unsupportedBySdp) {
      problems.push(
        `${leg.label} ${leg.mint} carries the ${extension} extension, which SDP cannot settle, cancel or reclaim yet`
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
 *
 * Returns null when the mint is missing or its bytes do not decode as a mint.
 * This is a pre-flight, not a gate: the program still verifies the decimals
 * against the mint on transfer, so a parse failure here costs only a round
 * trip, not a wrong quantity.
 *
 * @param rpc - Solana RPC to read the mint from.
 * @param mint - The mint address.
 * @returns The mint's decimals, or null when the mint is missing or undecodable.
 */
export async function readMintDecimals(rpc: SolanaRpc, mint: Address): Promise<number | null> {
  try {
    const account = await fetchMaybeMint(rpc, mint);
    return account.exists ? account.data.decimals : null;
  } catch {
    return null;
  }
}

/**
 * Names the ruled-out extensions present on a mint's raw account data: those
 * the program refuses, and those SDP cannot move yet.
 *
 * Returns null on data it cannot decode, and the caller refuses the mint. The
 * program enforces its own refusals on chain, but not SDP's: an unreadable
 * mint could carry a transfer hook, and accepting it would strand the funded
 * leg.
 *
 * @param account - A fetched, existing account owned by Token-2022.
 * @returns The ruled-out extension names present, split by who rules them out,
 *   or null when the mint cannot be decoded.
 */
function readMintExtensionProblems(account: EncodedAccount): {
  refusedByProgram: string[];
  unsupportedBySdp: string[];
} | null {
  let mint: Account<Mint>;
  try {
    mint = decodeMint(account);
  } catch {
    return null;
  }
  const kinds =
    mint.data.extensions.__option === "Some"
      ? mint.data.extensions.value.map((extension) => extension.__kind)
      : [];
  return {
    refusedByProgram: kinds.filter((kind) => BLOCKED_MINT_EXTENSIONS.has(kind)),
    unsupportedBySdp: kinds.filter((kind) => UNSUPPORTED_MINT_EXTENSIONS.has(kind)),
  };
}
