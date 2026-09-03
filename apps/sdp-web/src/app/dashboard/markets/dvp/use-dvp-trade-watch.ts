"use client";

/**
 * Keeping an open trade's page current without anyone asking it to.
 *
 * A DvP trade changes because of something the person watching did not do. The
 * counterparty pays into an escrow, and nothing tells us: the program emits no
 * events, so the only way to learn about a deposit is to look. Until this, the
 * page looked exactly once — when it was rendered — and then sat there. The
 * deposit landed, the reconciler recorded it a minute later, and the screen went
 * on saying "Waiting on funds" until somebody reloaded by hand.
 *
 * That is the thing this product is for. A page that cannot show it arriving is
 * a page you have to distrust and refresh, which is worse than no page.
 *
 * `router.refresh()` re-runs the server render and reconciles it into the live
 * tree, so nothing on screen is unmounted: scroll position, an open dialog and
 * a half-copied address all survive.
 */

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import type { DvpTrade } from "./dvp-trade";
import { isDvpTradeClosed } from "./dvp-trade";

/**
 * Short enough that a deposit appears while you are still looking at the page,
 * and paired on the API side with a staleness window of the same order — so a
 * poll usually costs a database read and only occasionally a chain read.
 */
const POLL_MS = 6_000;

/**
 * Re-reads an open trade on an interval, while the tab is being looked at.
 *
 * Stops on a closed trade: settled and cancelled are terminal, and polling one
 * spends requests to be told the same thing forever.
 *
 * @param trade - The trade currently rendered.
 */
export function useDvpTradeWatch(trade: DvpTrade): void {
  const router = useRouter();
  const closed = isDvpTradeClosed(trade);

  useEffect(() => {
    if (closed) {
      return;
    }

    // One timer, allocated here and cleared here. It was a start/stop pair
    // driven by visibility, which owned the handle in a closure two functions
    // away — correct, but neither a reader nor a linter can see that every
    // allocation is released, and the whole point of a cleanup is that it is
    // obvious. A backgrounded tab is nobody watching, so the tick checks
    // rather than the timer being torn down; browsers throttle background
    // timers anyway, and a no-op tick costs nothing.
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        router.refresh();
      }
    }, POLL_MS);

    // Coming back to the tab is the moment the page is most likely to be
    // wrong, so it re-reads immediately rather than waiting out an interval.
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        router.refresh();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [closed, router]);
}
