import { createRpc } from "@sdp/rpc/solana";
import type { SdpEnvironment } from "@sdp/types";
import { type Address, address } from "@solana/kit";
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
 */
export interface OwnerMintBalance {
  /** Sum across the owner's token accounts for the mint, base units. */
  atoms: bigint;
  /** The mint's decimals as the RPC reports them, or null when no account exists. */
  decimals: number | null;
}

type MintFilteredTokenAccountsRpc = {
  getTokenAccountsByOwner: (
    owner: Address,
    filter: { mint: Address },
    config: { encoding: "jsonParsed"; commitment: "confirmed" }
  ) => {
    send: () => Promise<{
      value?: Array<{
        account?: {
          data?: {
            parsed?: { info?: { tokenAmount?: { amount?: unknown; decimals?: unknown } } };
          };
        };
      }>;
    }>;
  };
};

export async function readOwnerMintBalance(
  env: Env,
  environment: SdpEnvironment,
  ownerAddress: string,
  mint: string
): Promise<OwnerMintBalance> {
  const cluster = earnClusterFor(environment);
  const rpcUrl = resolveClusterRpcUrl(env, cluster);
  await assertClusterEndpoint(env, cluster, rpcUrl);
  const rpc = createRpc(env, { rpcUrl }) as unknown as MintFilteredTokenAccountsRpc;

  const response = await rpc
    .getTokenAccountsByOwner(
      address(ownerAddress),
      { mint: address(mint) },
      { encoding: "jsonParsed", commitment: "confirmed" }
    )
    .send();

  let atoms = 0n;
  let decimals: number | null = null;
  for (const entry of response.value ?? []) {
    const tokenAmount = entry.account?.data?.parsed?.info?.tokenAmount;
    const rawAmount = tokenAmount?.amount;
    const rawDecimals = tokenAmount?.decimals;
    if (typeof rawAmount !== "string" && typeof rawAmount !== "number") continue;
    if (typeof rawDecimals !== "number" || !Number.isInteger(rawDecimals)) continue;
    atoms += BigInt(String(rawAmount));
    decimals = rawDecimals;
  }
  return { atoms, decimals };
}
