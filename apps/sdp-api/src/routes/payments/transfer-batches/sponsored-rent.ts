import type { SponsorshipProviderConfiguration } from "@sdp/fee-payment/port";
import { createClusterRpc } from "@sdp/rpc/factory";
import { GET_MULTIPLE_ACCOUNTS_LIMIT } from "@sdp/rpc/solana";
import { SPL_TOKEN_PROGRAMS } from "@sdp/types/well-known-tokens";
import {
  type Address,
  fetchEncodedAccounts,
  type MaybeEncodedAccount,
  unwrapOption,
} from "@solana/kit";
import {
  decodeMint,
  type Extension,
  type ExtensionArgs,
  extension,
  getTokenSize,
} from "@solana-program/token-2022";
import { internalError } from "@/lib/errors";
import { readRentExemptMinimum } from "@/services/payments/rent-exempt-minimum";
import type { RecipientInstructionGroup, SponsoredRentLimit } from "./transaction";
import type { TokenContext } from "./types";

/**
 * The account extensions Token-2022 adds to every token account of a mint carrying the key
 * extension (`get_required_init_account_extensions`), which the associated token program sizes
 * the account with. Confidential-transfer account extensions are added later, by
 * `ConfigureAccount`, never at creation. Sizes are checked against the chain's own
 * `GetAccountDataSize` in sponsored-rent.test.ts.
 */
const REQUIRED_ACCOUNT_EXTENSIONS = {
  TransferFeeConfig: extension("TransferFeeAmount", { withheldAmount: 0n }),
  NonTransferable: extension("NonTransferableAccount", {}),
  TransferHook: extension("TransferHookAccount", { transferring: false }),
  PausableConfig: extension("PausableAccount", {}),
} as const satisfies Partial<Record<Extension["__kind"], ExtensionArgs>>;

/**
 * The size of the associated token account the sponsor creates for one recipient: 165 bytes
 * under the legacy token program; under Token-2022, the account type byte, ImmutableOwner (which
 * the associated token program always adds) and every account extension the mint requires.
 *
 * @param tokenProgram - The mint's owning token program.
 * @param mint - The mint account, read in the same call as the recipients' accounts; unread for
 *   the legacy program.
 * @returns The account data length in bytes.
 */
export function associatedTokenAccountSize(
  tokenProgram: Address,
  mint: MaybeEncodedAccount | undefined
): number {
  if (tokenProgram !== SPL_TOKEN_PROGRAMS["token-2022"]) return getTokenSize();
  if (mint === undefined || !mint.exists || mint.programAddress !== tokenProgram) {
    throw internalError("The batch mint was not readable as a Token-2022 mint");
  }
  const mintExtensions = unwrapOption(decodeMint(mint).data.extensions) ?? [];
  // Widened so any mint extension kind can be looked up; most require no account extension.
  const requiredByMintExtension: Partial<Record<Extension["__kind"], ExtensionArgs>> =
    REQUIRED_ACCOUNT_EXTENSIONS;
  const required = mintExtensions.flatMap((mintExtension) => {
    const accountExtension = requiredByMintExtension[mintExtension.__kind];
    return accountExtension === undefined ? [] : [accountExtension];
  });
  return getTokenSize([extension("ImmutableOwner", {}), ...required]);
}

async function fetchAccountPages(addresses: readonly Address[]): Promise<MaybeEncodedAccount[]> {
  const rpc = createClusterRpc();
  const pages: Address[][] = [];
  for (let start = 0; start < addresses.length; start += GET_MULTIPLE_ACCOUNTS_LIMIT) {
    pages.push(addresses.slice(start, start + GET_MULTIPLE_ACCOUNTS_LIMIT));
  }
  const accounts = await Promise.all(
    pages.map((page) => fetchEncodedAccounts(rpc, page, { commitment: "confirmed" }))
  );
  return accounts.flat();
}

/**
 * What the sponsor funds per transaction for the batch (HOO-2024): the distinct destination token
 * accounts that hold no account of the batch's token program, each priced at the rent-exempt
 * minimum for its size, and the scope's Kora cap on that outflow. A SOL batch creates nothing and
 * reads nothing.
 *
 * RPC: one `getMultipleAccounts` per 100 addresses (the recipients' token accounts, with the mint
 * under Token-2022). Only when an account is missing, then concurrently: one
 * `getMinimumBalanceForRentExemption` for its size (cached per cluster and size for an hour) and
 * one Kora `getConfig` for the cap.
 *
 * @param params.groups - Instruction groups with derived destination token accounts.
 * @param params.tokenContext - Resolved token parameters for the batch.
 * @param params.readConfiguration - Reads the scope's Kora configuration.
 * @returns Rent by missing destination token account, and the cap (null when none is missing).
 */
export async function readSponsoredRentLimit(params: {
  groups: readonly RecipientInstructionGroup[];
  tokenContext: TokenContext;
  readConfiguration: () => Promise<SponsorshipProviderConfiguration>;
}): Promise<SponsoredRentLimit> {
  const { tokenContext } = params;
  if (tokenContext.kind === "sol") return { rentByTokenAccount: new Map(), capLamports: null };
  const tokenAccounts = [
    ...new Set(params.groups.flatMap((group) => group.destinationTokenAccount ?? [])),
  ];
  const readsMint = tokenContext.tokenProgram === SPL_TOKEN_PROGRAMS["token-2022"];
  const addresses = readsMint ? [tokenContext.mintAddress, ...tokenAccounts] : tokenAccounts;
  const accounts = await fetchAccountPages(addresses);
  if (accounts.length !== addresses.length) {
    throw internalError("getMultipleAccounts did not answer for every batch account");
  }
  const tokenAccountReads = readsMint ? accounts.slice(1) : accounts;
  // An address holding lamports but no token account is still created, so it counts.
  const missing = tokenAccounts.filter((_, position) => {
    const account = tokenAccountReads[position];
    return !account.exists || account.programAddress !== tokenContext.tokenProgram;
  });
  if (missing.length === 0) return { rentByTokenAccount: new Map(), capLamports: null };

  const [rent, configuration] = await Promise.all([
    readRentExemptMinimum(
      associatedTokenAccountSize(tokenContext.tokenProgram, readsMint ? accounts[0] : undefined)
    ),
    params.readConfiguration(),
  ]);
  return {
    rentByTokenAccount: new Map(missing.map((tokenAccount) => [tokenAccount, rent])),
    capLamports: configuration.maxAllowedLamports,
  };
}
