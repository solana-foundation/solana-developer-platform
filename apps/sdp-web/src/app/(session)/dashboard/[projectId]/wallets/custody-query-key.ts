import type { Arguments } from "swr";
import { issuanceQueryKeys } from "@/app/(session)/dashboard/[projectId]/issuance/issuance-query-key";
import { earnQueryKeys } from "@/app/(session)/dashboard/[projectId]/markets/earn/earn-query-key";
import { paymentsQueryKeys } from "@/app/(session)/dashboard/[projectId]/payments/payments-query-key";

const WALLET_CARD_BALANCE_FALLBACK_PREFIX = "wallet-card-balance-fallback:";

export const custodyQueryKeys = {
  walletActivity: ({ walletId }: { walletId: string }) => ["wallet-activity", walletId] as const,
  /** Keyed to the server read so a later visit never starts from an earlier visit's cache. */
  walletBalances: ({ walletId, readAt }: { walletId: string; readAt: number }) =>
    ["wallet-balances", walletId, readAt] as const,
  walletCardBalances: () => "wallet-card-balances",
  /** The Project's pending Fireblocks registration; the SWR cache itself is per Project. */
  pendingFireblocksCsr: () => "pending-fireblocks-csr",
  /** The custody wallet's Fireblocks proposal lists, one page per kind. */
  fireblocksProposals: ({
    walletId,
    kind,
    offset,
  }: {
    walletId: string;
    kind: "signing" | "transfer";
    offset: number;
  }) => ["fireblocks-proposals", walletId, kind, offset] as const,
  walletCardBalanceFallback: ({ walletId }: { walletId: string }) =>
    `${WALLET_CARD_BALANCE_FALLBACK_PREFIX}${walletId}`,
  /** Balances and activity of any wallet, as shown on the wallet pages. */
  isWalletLiveDataKey: (key: Arguments) =>
    (Array.isArray(key) && (key[0] === "wallet-balances" || key[0] === "wallet-activity")) ||
    key === custodyQueryKeys.walletCardBalances() ||
    (typeof key === "string" && key.startsWith(WALLET_CARD_BALANCE_FALLBACK_PREFIX)),
  /** The wallet inventories other features read (payments, Earn, issuance pickers). */
  isWalletInventoryKey: (key: Arguments) =>
    key === paymentsQueryKeys.actionWallets() ||
    key === earnQueryKeys.fundingWallets() ||
    issuanceQueryKeys.isWalletInventoryKey(key),
};
