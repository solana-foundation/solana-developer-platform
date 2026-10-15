"use client";

import { useSyncExternalStore } from "react";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import {
  EMPTY_WALLET_FAVORITES,
  readWalletFavorites,
  subscribeWalletFavorites,
  walletFavoritesKey,
} from "@/lib/wallet-favorites";

/**
 * The wallets pinned to the sidebar for the current person, organization and project, with the
 * storage key the mutators in `@/lib/wallet-favorites` take (null without a project). Empty on
 * the server and the first client render; the stored pins arrive on the next render.
 */
export function useWalletFavorites() {
  const { dashboardCacheScope, selectedProjectId } = useDashboardWorkspace();
  const storageKey = walletFavoritesKey(dashboardCacheScope, selectedProjectId);
  const favorites = useSyncExternalStore(
    subscribeWalletFavorites,
    () => (storageKey ? readWalletFavorites(storageKey) : EMPTY_WALLET_FAVORITES),
    () => EMPTY_WALLET_FAVORITES
  );
  return { storageKey, favorites };
}
