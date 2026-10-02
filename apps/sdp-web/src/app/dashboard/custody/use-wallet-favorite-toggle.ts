"use client";

import { useMemo } from "react";
import { toast } from "sonner";
import { useWalletFavorites } from "@/components/use-wallet-favorites";
import { useTranslations } from "@/i18n/provider";
import {
  addWalletFavorite,
  readWalletFavorites,
  reinsertWalletFavorite,
  removeWalletFavorite,
  type WalletFavorite,
} from "@/lib/wallet-favorites";

/**
 * Pins or unpins a wallet and says so in a toast with Undo. Undo reverses only that toggle, so
 * an unpinned wallet returns to its old place in the sidebar and a later pin or unpin survives.
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
    const current = readWalletFavorites(storageKey);
    const index = current.findIndex((entry) => entry.walletId === favorite.walletId);
    if (index >= 0) {
      const removed = current[index] ?? favorite;
      removeWalletFavorite(storageKey, favorite.walletId);
      toast(t("DashboardCustody.favoriteRemoved"), {
        description: t("DashboardCustody.favoriteRemovedDescription", { wallet: favorite.name }),
        action: {
          label: t("DashboardCustody.undo"),
          onClick: () => reinsertWalletFavorite(storageKey, removed, index),
        },
      });
      return;
    }
    addWalletFavorite(storageKey, favorite);
    toast(t("DashboardCustody.favoriteAdded"), {
      description: t("DashboardCustody.favoriteAddedDescription", { wallet: favorite.name }),
      action: {
        label: t("DashboardCustody.undo"),
        onClick: () => removeWalletFavorite(storageKey, favorite.walletId),
      },
    });
  };

  return { canPin: storageKey !== null, favoriteIds, toggle };
}
