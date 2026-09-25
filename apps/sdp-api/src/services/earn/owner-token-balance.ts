import { createRpc } from "@sdp/rpc/solana";
import type { SdpEnvironment } from "@sdp/types";
import { address } from "@solana/kit";
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
 */
export interface OwnerMintBalance {
  /** Sum across the owner's token accounts for the mint, base units. */
  atoms: bigint;
  /** The mint's decimals as the RPC reports them, or null when no account exists. */
  decimals: number | null;
  /**
   * Whether the response provably covers the owner's whole balance of the
   * mint: at least one mint-filtered account was observed, or a FINALIZED
   * read reported none. The reader pins `finalized`, so in production this
   * is always true; the field is computed from the commitment so relaxing
   * it (e.g. to `confirmed`) automatically retracts completeness from empty
   * reads instead of silently certifying them as zero (SOLA9-675). An empty
   * list at a weaker commitment is indistinguishable from an RPC response
   * that lagged or lost its accounts, so it reads as zero atoms but never
   * as verified.
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
  // `finalized` is the commitment that certifies an empty account list: a
  // confirmed read can lag the owner's own transaction, and `value: []` would
  // otherwise read as zero through an incomplete response (SOLA9-675). Kit
  // elides an explicit `finalized` from the wire because it matches the HTTP
  // server default, so the request is served at finalized either way; a
  // weaker commitment here WOULD reach the node and undermine the
  // completeness signal below.
  const commitment = "finalized" as const;
  const response = await createRpc(env, { rpcUrl })
    .getTokenAccountsByOwner(
      address(ownerAddress),
      { mint: address(mint) },
      { encoding: "jsonParsed", commitment }
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
  // The call filtered by mint, so any entry observed is provably in scope and
  // the sum covers the owner's whole balance. A non-empty response is complete
  // evidence whatever the commitment; an EMPTY response certifies a zero
  // balance only at `finalized` (SOLA9-675), where the served account set is
  // irreversible. Deliberately a function of `commitment`, not a constant:
  // with the pinned commitment above the second disjunct is true by
  // construction, and relaxing the commitment retracts completeness from
  // empty reads, making the detector's IncompleteBalanceRead branch live
  // instead of silently certifying lagged zeros as zero balances.
  const complete = parsed.data.value.length > 0 || commitment === "finalized";
  return { atoms, decimals, complete };
}
