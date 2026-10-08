"use client";

import { useCallback, useRef } from "react";
import useSWR from "swr";
import { z } from "zod";
import { dashboardRequest } from "@/lib/dashboard-fetch";
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
  custodyConfigId: z.string().optional(),
  custodyConnectionId: z.string().optional(),
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
    balanceReadContext: z
      .object({ minimumSlot: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })
      .optional(),
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
  const response = await dashboardRequest(WALLETS_PATH, {});
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
  walletId: string,
  minimumSlot?: number
): Promise<NonNullable<EarnFundingWallet["balances"]>> {
  const query = minimumSlot === undefined ? "" : `?minimumSlot=${minimumSlot}`;
  const response = await dashboardRequest(
    `/api/dashboard/payments/wallets/${encodeURIComponent(walletId)}/balances${query}`,
    { cache: "no-store" }
  );
  if (!response.ok) {
    throw new Error(`Request failed (${response.status})`);
  }
  const parsed = fundingWalletBalanceResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Invalid custody wallet balance response");
  }
  if (
    minimumSlot !== undefined &&
    (parsed.data.data.balanceReadContext?.minimumSlot ?? -1) < minimumSlot
  ) {
    throw new Error("Wallet balance read did not establish confirmation freshness");
  }
  return parsed.data.data.walletBalances.balances;
}

/**
 * A refresh completes only when every visible wallet was read successfully.
 * Reject partial failure so Treasury cannot clear its updating/error state
 * while any wallet still carries a cached pre-transfer balance.
 */
export async function refreshFundingWalletBalances(
  wallets: readonly EarnFundingWallet[],
  minimumSlot?: number | ReadonlyMap<string, number>
): Promise<EarnFundingWallet[]> {
  const slotsByAddress = new Map<string, number>();
  if (typeof minimumSlot === "object") {
    for (const wallet of wallets) {
      const slot = minimumSlot.get(wallet.id);
      if (slot !== undefined)
        slotsByAddress.set(
          wallet.publicKey,
          Math.max(slotsByAddress.get(wallet.publicKey) ?? 0, slot)
        );
    }
  }
  return Promise.all(
    wallets.map(async (wallet) => {
      const slot =
        typeof minimumSlot === "number" ? minimumSlot : slotsByAddress.get(wallet.publicKey);
      const balances = await fetchLiveFundingWalletBalance(wallet.walletId, slot);
      return { ...wallet, balances };
    })
  );
}

export function useEarnFundingWallets() {
  const minimumSlot = useRef<number | undefined>(undefined);
  const walletMinimumSlots = useRef(new Map<string, number>());
  const read = async () => {
    const wallets = await fetchFundingWallets();
    return minimumSlot.current === undefined && walletMinimumSlots.current.size === 0
      ? wallets
      : refreshFundingWalletBalances(wallets, minimumSlot.current ?? walletMinimumSlots.current);
  };
  const { data, error, isLoading, mutate } = useSWR(earnQueryKeys.fundingWallets(), read);
  const refreshBalances = useCallback(
    (slot?: number, custodyWalletIds?: readonly string[]) => {
      if (slot !== undefined) {
        if (custodyWalletIds && minimumSlot.current === undefined) {
          for (const id of custodyWalletIds)
            walletMinimumSlots.current.set(
              id,
              Math.max(walletMinimumSlots.current.get(id) ?? 0, slot)
            );
        } else
          minimumSlot.current = Math.max(
            minimumSlot.current ?? 0,
            slot,
            ...walletMinimumSlots.current.values()
          );
      }
      return mutate(
        async () =>
          refreshFundingWalletBalances(
            await fetchFundingWallets(),
            minimumSlot.current ?? walletMinimumSlots.current
          ),
        {
          revalidate: false,
          throwOnError: true,
        }
      );
    },
    [mutate]
  );
  return { wallets: data, error, isLoading, refresh: () => void mutate(), refreshBalances };
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
