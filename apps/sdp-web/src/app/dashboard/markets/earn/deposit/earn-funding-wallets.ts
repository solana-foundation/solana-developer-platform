"use client";

import useSWR from "swr";
import { z } from "zod";
import { earnQueryKeys } from "../earn-query-key";

/**
 * Funding wallets for the deposit flow: the org's own SDP wallets, plus the
 * display helpers every surface that names one needs.
 *
 * An SDP wallet is the funding source, never the Earn product itself. For a
 * custodial program the operator transfers funds to the provider's address, so
 * the choice shapes instructions only. For a `vault_direct` deposit the chosen
 * custody-wallet row is sent to the API because that wallet signs the on-chain
 * deposit and holds the resulting shares. One live wallet inventory serves
 * both flows; their write contracts remain deliberately separate.
 */

const walletTokenBalanceSchema = z.object({
  token: z.string(),
  mint: z.string(),
  amount: z.string(),
  uiAmount: z.string(),
  decimals: z.number(),
  usdPrice: z.number().optional(),
  usdValue: z.number().optional(),
});

/**
 * The wallet fields this seam actually promises its callers, PARSED rather than
 * asserted.
 *
 * The envelope walk this replaced proved only that `data.wallets` was an array
 * and then cast the rows to the full custody type — so a response missing
 * `publicKey` (the address a deposit is signed from) type-checked as a complete
 * wallet and failed later, somewhere else. Parsing here means a malformed row
 * fails loudly at the boundary that read it. The row type is derived from this
 * schema, so the two cannot drift.
 */
const earnFundingWalletSchema = z.object({
  id: z.string(),
  walletId: z.string(),
  publicKey: z.string(),
  /**
   * Custody provider name, for display only. Optional and deliberately not an
   * enum: it labels a badge, and a provider id this build has not heard of must
   * not fail the row and disable deposits over a caption.
   */
  provider: z.string().optional(),
  label: z.string().nullable(),
  purpose: z.string().nullable(),
  status: z.enum(["active", "inactive"]),
  isRuntimeExecutionAllowed: z.boolean(),
  balances: z.array(walletTokenBalanceSchema).optional(),
});

/**
 * An invalid success envelope is an upstream failure, not an empty wallet list.
 * Treating it as `[]` would disable deposits while claiming the org simply has
 * no wallets.
 */
const fundingWalletsResponseSchema = z.object({
  data: z.object({
    wallets: z.array(earnFundingWalletSchema),
  }),
});

const fundingWalletBalanceResponseSchema = z.object({
  data: z.object({
    walletBalances: z.object({
      balances: z.array(walletTokenBalanceSchema),
    }),
  }),
});

export type EarnFundingWallet = z.infer<typeof earnFundingWalletSchema>;

/**
 * Balances come from live RPC reads, so they are opt-in per request and served
 * from short-TTL caches on both sides. They are shown as context only — never
 * as a gate on what the user may deposit.
 */
const WALLETS_PATH =
  "/api/dashboard/wallets?view=summary&includeBalances=true&includeAllProviders=true";

export async function fetchFundingWallets(): Promise<EarnFundingWallet[]> {
  const response = await fetch(WALLETS_PATH);
  if (!response.ok) {
    throw new Error(`Request failed (${response.status})`);
  }
  const parsed = fundingWalletsResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Invalid custody wallet response");
  }
  // Only usable funding sources: an inactive wallet cannot originate a transfer.
  return parsed.data.data.wallets.filter((wallet) => wallet.status === "active");
}

/**
 * Read one wallet directly from the uncached Payments balance endpoint.
 *
 * The collection endpoint intentionally keeps a short API-side cache for
 * normal dashboard reads. That cache is the wrong source immediately after a
 * vault movement settles: both the submit refresh and the settlement refresh
 * can otherwise land inside the same cache window and leave Treasury frozen
 * on the pre-transaction balance.
 */
export async function fetchLiveFundingWalletBalance(
  walletId: string
): Promise<NonNullable<EarnFundingWallet["balances"]>> {
  const response = await fetch(
    `/api/dashboard/payments/wallets/${encodeURIComponent(walletId)}/balances`,
    { cache: "no-store" }
  );
  if (!response.ok) {
    throw new Error(`Request failed (${response.status})`);
  }
  const parsed = fundingWalletBalanceResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Invalid custody wallet balance response");
  }
  return parsed.data.data.walletBalances.balances;
}

/**
 * Refresh every visible wallet independently. A failed live read preserves
 * that wallet's previous observation, including `undefined`; it never turns
 * unavailable into an invented zero and it does not block healthy wallets
 * from updating.
 */
export async function refreshFundingWalletBalances(
  wallets: readonly EarnFundingWallet[]
): Promise<EarnFundingWallet[]> {
  return Promise.all(
    wallets.map(async (wallet) => {
      try {
        const balances = await fetchLiveFundingWalletBalance(wallet.walletId);
        return { ...wallet, balances };
      } catch {
        return wallet;
      }
    })
  );
}

export function useEarnFundingWallets() {
  const { data, error, isLoading, mutate } = useSWR(earnQueryKeys.fundingWallets(), () =>
    fetchFundingWallets()
  );
  return {
    wallets: data,
    error,
    isLoading,
    refresh: () => void mutate(),
    refreshBalances: () =>
      void mutate(async () => refreshFundingWalletBalances(await fetchFundingWallets()), {
        revalidate: false,
      }),
  };
}

// --- Display helpers -------------------------------------------------------

/**
 * What to call a wallet on screen. THE single source for this: a wallet label is
 * user-set and nullable, and `||` (not `??`) is required so a label of spaces
 * falls back instead of rendering an empty name.
 */
export function walletDisplayName(wallet: EarnFundingWallet | undefined, fallback: string): string {
  return wallet?.label?.trim() || fallback;
}
