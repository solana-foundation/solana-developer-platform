"use client";

import { useState } from "react";
import {
  WALLET_ACTIVITY_LIMIT,
  WALLET_ACTIVITY_MAX_LIMIT,
  type WalletActivityPayload,
} from "@/app/dashboard/custody/wallet-activity.data";
import { useWalletActivity } from "./use-wallet-activity";

/** How many more rows each "Load older activity" asks the feed for. */
export const WALLET_ACTIVITY_LOAD_STEP = 100;

/**
 * A wider read only replaces the loaded window when it is at least as complete: no source
 * that answered for the loaded window may go missing in the wider one.
 */
function isAsComplete(wider: WalletActivityPayload, loaded: WalletActivityPayload | undefined) {
  if (wider.activityError) return false;
  return wider.activityNotice === null || wider.activityNotice === loaded?.activityNotice;
}

/**
 * The Activity tab's window onto the wallet's feed. It shows the window that last loaded and
 * keeps refreshing it; "Load older activity" asks for a window `WALLET_ACTIVITY_LOAD_STEP` rows
 * wider, which replaces the shown one only once it loads in full. A wider read that fails, or
 * comes back missing a source, leaves the shown window as it was and reports `olderFailed`;
 * `loadOlder` then retries that same size instead of widening again.
 */
export function useWalletActivityWindow(walletId: string) {
  const [loadedLimit, setLoadedLimit] = useState(WALLET_ACTIVITY_LIMIT);
  const [requestedLimit, setRequestedLimit] = useState(WALLET_ACTIVITY_LIMIT);
  const shown = useWalletActivity(walletId, loadedLimit);
  const wider = useWalletActivity(walletId, requestedLimit);

  const widening = requestedLimit !== loadedLimit;
  const widerLoaded = widening && wider.data !== undefined && isAsComplete(wider.data, shown.data);
  if (widerLoaded) {
    // The wider window is already cached, so `shown` reads it on the re-render this queues.
    setLoadedLimit(requestedLimit);
  }
  // Settled without loading in full; a retry in flight counts as loading again.
  const olderFailed =
    widening &&
    !widerLoaded &&
    !wider.isValidating &&
    (wider.error !== undefined || wider.data !== undefined);

  const data = shown.data;
  return {
    data,
    /** The shown window never loaded. */
    error: data === undefined ? shown.error : undefined,
    /** The shown window loaded once, but its latest refresh failed. */
    refreshFailed: data !== undefined && shown.error !== undefined,
    /** Rows older than the shown window exist and the feed can still widen to them. */
    canLoadOlder: data?.hasMore === true && loadedLimit < WALLET_ACTIVITY_MAX_LIMIT,
    loadingOlder: widening && !olderFailed,
    olderFailed,
    loadOlder: () => {
      if (olderFailed) {
        void wider.mutate();
        return;
      }
      if (widening) return;
      setRequestedLimit(
        Math.min(WALLET_ACTIVITY_MAX_LIMIT, loadedLimit + WALLET_ACTIVITY_LOAD_STEP)
      );
    },
  };
}
