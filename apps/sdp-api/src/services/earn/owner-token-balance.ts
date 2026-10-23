import type { SdpEnvironment } from "@sdp/types/api-keys";
import { address, type Slot } from "@solana/kit";
import { z } from "zod";
import { earnClusterRpc } from "@/services/earn/cluster-rpc";
import { earnClusterFor } from "@/services/earn/execution-registry";

/**
 * One owner's balance of ONE mint, in base units, on the environment's own
 * cluster (PRO-1864).
 *
 * Written for the orphaned split-swap detector and its build-time baseline,
 * which must be the SAME measurement or the difference between them means
 * nothing: same cluster pool, same genesis guard, same filtered RPC call, same
 * summing rule. `getSplTokenBalances` (routes/payments/token-accounts.ts)
 * is the wrong tool here: it walks every token account of both token programs
 * to answer a question about one mint, and it returns decimal strings where the
 * comparison needs atoms.
 *
 * Filtering by `mint` rather than `programId` is one call, not two: a mint
 * belongs to exactly one token program, and the RPC resolves it.
 *
 * The read goes to the environment's own cluster pool, whose genesis guard is
 * not optional: without it a mis-pointed sandbox would judge devnet advisories
 * against mainnet balances and never notice.
 */
export interface OwnerMintBalance {
  /** Sum across the owner's token accounts for the mint, base units. */
  atoms: bigint;
  /** The mint's decimals as the RPC reports them, or null when no account exists. */
  decimals: number | null;
}

const mintFilteredTokenAccountsResponseSchema = z.object({
  context: z.object({ slot: z.bigint() }),
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

/**
 * @param environment - The environment whose cluster holds the balance.
 * @param ownerAddress - The wallet whose accounts are summed.
 * @param mint - The one mint to sum.
 * @param options - `minContextSlot`: the lowest slot the answering node may be at. A node behind it
 * errors instead of answering (and the pool tries the next endpoint), so a balance judged against a
 * height read can never come from a node that predates that height.
 * @returns The summed atoms and the mint's decimals.
 * @throws Error when the response is malformed, out of scope, or answered below `minContextSlot`.
 */
export async function readOwnerMintBalance(
  environment: SdpEnvironment,
  ownerAddress: string,
  mint: string,
  options?: { minContextSlot: Slot }
): Promise<OwnerMintBalance> {
  const minContextSlot = options?.minContextSlot;
  const response = await earnClusterRpc(earnClusterFor(environment))
    .getTokenAccountsByOwner(
      address(ownerAddress),
      { mint: address(mint) },
      {
        encoding: "jsonParsed",
        commitment: "confirmed",
        ...(minContextSlot === undefined ? {} : { minContextSlot }),
      }
    )
    .send();
  const parsed = mintFilteredTokenAccountsResponseSchema.safeParse(response);
  if (!parsed.success) {
    throw new Error("Mint-filtered token-account RPC response was malformed", {
      cause: parsed.error,
    });
  }
  if (minContextSlot !== undefined && parsed.data.context.slot < minContextSlot) {
    throw new Error(
      `Mint-filtered token-account RPC answered at slot ${parsed.data.context.slot}, ` +
        `below its floor ${minContextSlot}`
    );
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
  return { atoms, decimals };
}
