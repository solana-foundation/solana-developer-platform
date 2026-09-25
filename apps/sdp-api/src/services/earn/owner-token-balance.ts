import { createRpc } from "@sdp/rpc/solana";
import type { SdpEnvironment } from "@sdp/types";
import { address, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { z } from "zod";
import {
  assertClusterEndpoint,
  earnClusterFor,
  resolveClusterRpcUrl,
} from "@/services/earn/execution-registry";
import type { Env } from "@/types/env";

/**
 * One owner's balance of ONE mint, in base units, on the environment's own
 * cluster (PRO-1864).
 *
 * Written for the orphaned split-swap detector and its build-time baseline,
 * which must be the SAME measurement or the difference between them means
 * nothing: same cluster resolution, same genesis check, same filtered RPC call,
 * same summing rule. `getSplTokenBalances` (routes/payments/token-accounts.ts)
 * is the wrong tool here: it walks every token account of both token programs
 * to answer a question about one mint, and it returns decimal strings where the
 * comparison needs atoms.
 *
 * Filtering by `mint` rather than `programId` is one call, not two: a mint
 * belongs to exactly one token program, and the RPC resolves it.
 *
 * The genesis assertion is not optional. `createRpc` with an empty URL falls
 * back to the process-default cluster, so without it a mis-pointed sandbox
 * would judge devnet advisories against mainnet balances and never notice.
 *
 * An EMPTY account list is reported, never silently trusted: an empty list is
 * indistinguishable from an incomplete index (SOLA9-675), so `complete` says
 * whether the sum is grounded in observed accounts, and `ownerHoldsMintAccount`
 * is the independent proof a caller needs before treating an empty read as a
 * conclusive zero.
 */
export interface OwnerMintBalance {
  /** Sum across the owner's token accounts for the mint, base units. */
  atoms: bigint;
  /** The mint's decimals as the RPC reports them, or null when no account exists. */
  decimals: number | null;
  /**
   * True when the RPC returned at least one account entry, so the sum rests on
   * observed account state. False for a bare empty list, which a broken or
   * incomplete index also returns — such a read must never be the sole ground
   * for a terminal judgement (SOLA9-675).
   */
  complete: boolean;
}

const mintFilteredTokenAccountsResponseSchema = z.object({
  value: z.array(
    z.object({
      account: z.object({
        data: z.object({
          parsed: z.object({
            type: z.literal("account"),
            info: z.object({
              mint: z.string(),
              owner: z.string(),
              tokenAmount: z.object({
                amount: z.string().regex(/^\d+$/),
                decimals: z.number().int().min(0).max(255),
              }),
            }),
          }),
        }),
      }),
    })
  ),
});

export async function readOwnerMintBalance(
  env: Env,
  environment: SdpEnvironment,
  ownerAddress: string,
  mint: string
): Promise<OwnerMintBalance> {
  const cluster = earnClusterFor(environment);
  const rpcUrl = resolveClusterRpcUrl(env, cluster);
  await assertClusterEndpoint(env, cluster, rpcUrl);
  const response = await createRpc(env, { rpcUrl })
    .getTokenAccountsByOwner(
      address(ownerAddress),
      { mint: address(mint) },
      { encoding: "jsonParsed", commitment: "confirmed" }
    )
    .send();
  const parsed = mintFilteredTokenAccountsResponseSchema.safeParse(response);
  if (!parsed.success) {
    throw new Error("Mint-filtered token-account RPC response was malformed", {
      cause: parsed.error,
    });
  }

  let atoms = 0n;
  let decimals: number | null = null;
  for (const [index, entry] of parsed.data.value.entries()) {
    const info = entry.account.data.parsed.info;
    if (info.mint !== mint || info.owner !== ownerAddress) {
      throw new Error(`Mint-filtered token-account RPC response entry ${index} was out of scope`);
    }
    if (decimals !== null && decimals !== info.tokenAmount.decimals) {
      throw new Error(
        `Mint-filtered token-account RPC response entry ${index} used inconsistent decimals`
      );
    }
    atoms += BigInt(info.tokenAmount.amount);
    decimals = info.tokenAmount.decimals;
  }
  return { atoms, decimals, complete: parsed.data.value.length > 0 };
}

/** The SPL Token program and Token-2022, the only programs that own token accounts. */
const TOKEN_PROGRAM_ADDRESSES = [
  // biome-ignore lint/security/noSecrets: well-known SPL Token program id, not a secret
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  // biome-ignore lint/security/noSecrets: well-known Token-2022 program id, not a secret
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
] as const;
// biome-ignore lint/security/noSecrets: well-known associated token program id, not a secret
const ASSOCIATED_TOKEN_PROGRAM_ADDRESS = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

/**
 * Independent account evidence that `ownerAddress` holds a token account of
 * `mint`, gathered WITHOUT the mint-filtered index
 * `readOwnerMintBalance` reads through (SOLA9-675): a program-filtered scan of
 * both token programs, plus a finalized existence check of the derived
 * associated token accounts, which are raw chain state no token-account index
 * can hide. True is a CONTRADICTION of a `complete: false` (empty) balance
 * read — the index missed at least one account — and callers must then keep
 * whatever judgement they were about to make open. False corroborates the
 * zero: both token programs index no account for the pair and neither derived
 * ATA exists on chain.
 *
 * Runs every read at `finalized` so the evidence cannot be unwound by a
 * reorganisation after it is acted on. Like `readOwnerMintBalance`, it proves
 * its cluster before reading and fails closed on a malformed response.
 */
export async function ownerHoldsMintAccount(
  env: Env,
  environment: SdpEnvironment,
  ownerAddress: string,
  mint: string
): Promise<boolean> {
  const cluster = earnClusterFor(environment);
  const rpcUrl = resolveClusterRpcUrl(env, cluster);
  await assertClusterEndpoint(env, cluster, rpcUrl);
  const rpc = createRpc(env, { rpcUrl });
  const owner = address(ownerAddress);
  const commitment = "finalized" as const;

  // The program-filtered scans answer the same question through each token
  // program's own index, so a mint-index that drops accounts is caught against
  // the program index when only it is wrong.
  for (const tokenProgram of TOKEN_PROGRAM_ADDRESSES) {
    const response = await rpc
      .getTokenAccountsByOwner(
        owner,
        { programId: address(tokenProgram) },
        {
          encoding: "jsonParsed",
          commitment,
        }
      )
      .send();
    const parsed = mintFilteredTokenAccountsResponseSchema.safeParse(response);
    if (!parsed.success) {
      throw new Error("Program-filtered token-account RPC response was malformed", {
        cause: parsed.error,
      });
    }
    for (const [index, entry] of parsed.data.value.entries()) {
      const info = entry.account.data.parsed.info;
      if (info.mint !== mint) continue;
      if (info.owner !== ownerAddress) {
        throw new Error(
          `Program-filtered token-account RPC response entry ${index} was out of scope`
        );
      }
      return true;
    }
  }

  // The derived associated token accounts are raw chain state, independent of
  // any token-account index: one existing is proof the empty index read lied.
  const addressEncoder = getAddressEncoder();
  const associatedAddresses = await Promise.all(
    TOKEN_PROGRAM_ADDRESSES.map(async (tokenProgram) => {
      const [associated] = await getProgramDerivedAddress({
        programAddress: address(ASSOCIATED_TOKEN_PROGRAM_ADDRESS),
        seeds: [
          addressEncoder.encode(owner),
          addressEncoder.encode(address(tokenProgram)),
          addressEncoder.encode(address(mint)),
        ],
      });
      return associated;
    })
  );
  const accounts = await rpc
    .getMultipleAccounts(
      associatedAddresses.map((associated) => address(associated)),
      {
        encoding: "base64",
        commitment,
        dataSlice: { offset: 0, length: 0 },
      }
    )
    .send();
  return accounts.value.some((account) => account !== null);
}
