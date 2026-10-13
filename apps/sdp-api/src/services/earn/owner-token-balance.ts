import { createClusterRpc } from "@sdp/rpc/factory";
import { address } from "@solana/kit";
import { z } from "zod";

/**
 * One owner's balance of ONE mint, in base units, on the open cluster scope's
 * cluster (PRO-1864).
 *
 * Written for the orphaned split-swap detector and its build-time baseline,
 * which must be the SAME measurement or the difference between them means
 * nothing: same door client, same filtered RPC call, same summing rule.
 * `getSplTokenBalances` (routes/payments/token-accounts.ts) is the wrong tool
 * here: it walks every token account of both token programs
 * to answer a question about one mint, and it returns decimal strings where the
 * comparison needs atoms.
 *
 * Filtering by `mint` rather than `programId` is one call, not two: a mint
 * belongs to exactly one token program, and the RPC resolves it.
 *
 * The door proves each endpoint's genesis before it serves a read, so a
 * mis-pointed endpoint can never judge devnet advisories against mainnet
 * balances.
 */
export interface OwnerMintBalance {
  /** Sum across the owner's token accounts for the mint, base units. */
  atoms: bigint;
  /** The mint's decimals as the RPC reports them, or null when no account exists. */
  decimals: number | null;
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

/**
 * Read one owner's balance of one mint on the open cluster scope's cluster.
 *
 * @param ownerAddress - The wallet whose token accounts to sum.
 * @param mint - The mint to sum.
 * @returns The summed atoms and the mint's decimals, null decimals when no account exists.
 * @throws Error when the RPC response is malformed, out of scope, or mixes decimals.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` outside a cluster scope.
 */
export async function readOwnerMintBalance(
  ownerAddress: string,
  mint: string
): Promise<OwnerMintBalance> {
  const response = await createClusterRpc()
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
  return { atoms, decimals };
}
