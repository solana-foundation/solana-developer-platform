"use client";

import { StarIcon } from "lucide-react";
import { useWalletFavoriteToggle } from "@/app/dashboard/custody/use-wallet-favorite-toggle";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import type { WalletFavorite } from "@/lib/wallet-favorites";

/** The star that pins a wallet to the sidebar, pressed while it is pinned. */
export function WalletFavoriteButton({
  favorite,
  pinned,
  onToggle,
  className,
}: {
  favorite: WalletFavorite;
  pinned: boolean;
  onToggle: (favorite: WalletFavorite) => void;
  className?: string;
}) {
  const t = useTranslations();
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-pressed={pinned}
      aria-label={t(
        pinned ? "DashboardCustody.removeFromFavorites" : "DashboardCustody.addToFavorites",
        { wallet: favorite.name }
      )}
      onClick={() => onToggle(favorite)}
      data-wallet-favorite={favorite.walletId}
      className={className}
    >
      <StarIcon className={cn("size-4.5", pinned && "fill-current")} />
    </Button>
  );
}

/** A wallet page's own star: pinned state and the toggle, or nothing where pins cannot keep. */
export function WalletFavoriteStar({ favorite }: { favorite: WalletFavorite }) {
  const { canPin, favoriteIds, toggle } = useWalletFavoriteToggle();
  if (!canPin) return null;
  return (
    <WalletFavoriteButton
      favorite={favorite}
      pinned={favoriteIds.has(favorite.walletId)}
      onToggle={toggle}
      className="rounded-full"
    />
  );
}
