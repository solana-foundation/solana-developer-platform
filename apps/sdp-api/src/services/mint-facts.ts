import { createClusterRpc } from "@sdp/rpc/factory";
import { currentClusterScope } from "@sdp/rpc/scope";
import { getAccountInfo } from "@sdp/rpc/solana";
import {
  type Account,
  type Address,
  isSolanaError,
  parseBase64RpcAccount,
  SOLANA_ERROR__ACCOUNTS__FAILED_TO_DECODE_ACCOUNT,
} from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { decodeMint, type Mint, TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { badRequest } from "@/lib/errors";
import { createMintLookupCache, type MintLookupLoad } from "@/services/mint-lookup-cache";

/**
 * An initialized mint's owner program, decimals and extension set are fixed at initialization, so
 * the hour bounds memory, not staleness. Closing the mint and recreating it at the same address
 * needs `MintCloseAuthority`, and such a mint is never kept; an uninitialized one is refused.
 */
const MINT_FACTS_TTL_MS = 60 * 60_000;

const mintFactsCache = createMintLookupCache<MintFacts>(MINT_FACTS_TTL_MS);

/** What every transfer of a mint is built from, read from the chain. */
export interface MintFacts {
  tokenProgram: Address;
  decimals: number;
  /**
   * Whether the mint carries the `TransferHook` extension. Its program and extra accounts stay
   * live (the hook authority can change them), so a transfer still resolves them per send.
   */
  hasTransferHook: boolean;
}

/** @internal Test-only: forget cached mint facts so specs are order-independent. */
export function clearMintFactsForTests(): void {
  mintFactsCache.clearForTests();
}

/**
 * The open cluster scope's facts for a mint: from the cache, a read already in flight, or one
 * `getAccountInfo` at `confirmed`. A refusal or a failed read is never cached.
 *
 * @param mint - The mint to read.
 * @returns The mint's token program, decimals and whether it carries a transfer hook.
 * @throws AppError BAD_REQUEST when no account is at the address, its owner is not a token
 *   program, its data is not a mint, or the mint is not initialized.
 */
export function readMintFacts(mint: Address): Promise<MintFacts> {
  return mintFactsCache.read(currentClusterScope().cluster, mint, () => loadMintFacts(mint));
}

/**
 * Reads a mint from the open scope's cluster.
 *
 * @param mint - The mint to read.
 * @returns Its facts, kept unless the mint can be closed.
 * @throws AppError BAD_REQUEST when no account is at the address, its owner is not a token
 *   program, its data is not a mint, or the mint is not initialized.
 */
async function loadMintFacts(mint: Address): Promise<MintLookupLoad<MintFacts>> {
  const accountInfo = await getAccountInfo(createClusterRpc(), mint);
  if (accountInfo === null) {
    throw badRequest("Token mint account does not exist");
  }
  const tokenProgram = assertSupportedTokenProgram(accountInfo.owner);
  const decoded = decodeMintAccount(mint, accountInfo);
  if (!decoded.data.isInitialized) {
    throw badRequest("Token mint is not initialized");
  }
  const extensions =
    decoded.data.extensions.__option === "Some" ? decoded.data.extensions.value : [];
  return {
    value: {
      tokenProgram,
      decimals: decoded.data.decimals,
      hasTransferHook: extensions.some((extension) => extension.__kind === "TransferHook"),
    },
    keep: !extensions.some((extension) => extension.__kind === "MintCloseAuthority"),
  };
}

/**
 * The mint's owner, when it is one of the two token programs.
 *
 * @param owner - The account's owner program.
 * @returns The token program.
 * @throws AppError BAD_REQUEST for any other owner.
 */
function assertSupportedTokenProgram(owner: Address): Address {
  if (owner === TOKEN_PROGRAM_ADDRESS || owner === TOKEN_2022_PROGRAM_ADDRESS) {
    return owner;
  }
  throw badRequest("Unsupported token program for mint");
}

/**
 * Decodes a token-program account as a mint; a token account pasted as a mint lands here.
 *
 * @param mint - The account's address.
 * @param accountInfo - The account as the RPC returned it.
 * @returns The decoded mint.
 * @throws AppError BAD_REQUEST when the data is not a mint.
 */
function decodeMintAccount(
  mint: Address,
  accountInfo: NonNullable<Awaited<ReturnType<typeof getAccountInfo>>>
): Account<Mint> {
  try {
    return decodeMint(parseBase64RpcAccount(mint, accountInfo));
  } catch (error) {
    if (isSolanaError(error, SOLANA_ERROR__ACCOUNTS__FAILED_TO_DECODE_ACCOUNT)) {
      throw badRequest("Token mint account could not be decoded");
    }
    throw error;
  }
}
