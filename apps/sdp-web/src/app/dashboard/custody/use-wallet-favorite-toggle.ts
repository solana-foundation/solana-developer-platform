"use client";

import { useMemo } from "react";
import { toast } from "sonner";
import { useWalletFavorites } from "@/components/use-wallet-favorites";
import { useTranslations } from "@/i18n/provider";
import {
  addWalletFavorite,
  readWalletFavorites,
  removeWalletFavorite,
  restoreWalletFavorites,
  type WalletFavorite,
} from "@/lib/wallet-favorites";

/**
 * Pins or unpins a wallet and says so in a toast with Undo. Undo puts the earlier list back
 * exactly, so an unpinned wallet returns to its old place in the sidebar.
 */
export function useWalletFavoriteToggle() {
  const t = useTranslations();
  const { storageKey, favorites } = useWalletFavorites();
  const favoriteIds = useMemo(
    () => new Set(favorites.map((favorite) => favorite.walletId)),
    [favorites]
  );

  const toggle = (favorite: WalletFavorite) => {
    if (!storageKey) return;
    const previous = readWalletFavorites(storageKey);
    const undo = {
      label: t("DashboardCustody.undo"),
      onClick: () => restoreWalletFavorites(storageKey, previous),
    };
    if (previous.some((entry) => entry.walletId === favorite.walletId)) {
      removeWalletFavorite(storageKey, favorite.walletId);
      toast(t("DashboardCustody.favoriteRemoved"), {
        description: t("DashboardCustody.favoriteRemovedDescription", { wallet: favorite.name }),
        action: undo,
      });
      return;
    }
    addWalletFavorite(storageKey, favorite);
    toast(t("DashboardCustody.favoriteAdded"), {
      description: t("DashboardCustody.favoriteAddedDescription", { wallet: favorite.name }),
      action: undo,
    });
  };

  return { canPin: storageKey !== null, favoriteIds, toggle };
}
