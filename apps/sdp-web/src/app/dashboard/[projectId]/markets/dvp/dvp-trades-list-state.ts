/**
 * Deciding what the DvP trades card is showing, kept out of the component file
 * so it can be tested on its own and the page keeps Fast Refresh.
 */

import type { DvpTradesUrlStatus } from "./dvp-trades-query";

/**
 * What the trades card should be: the empty invitation, "nothing matches", or
 * the table, and whether the filter bar has to stay.
 *
 * `trades` is what the server returned for `returned`, the filters in the URL at
 * fetch time. While any filter is applied, on those rows or on the ones just
 * chosen and still loading, an empty or one-row answer says nothing about the
 * project. Reading emptiness off those rows took the bar away with no route back
 * to the other statuses, and clearing a filter flashed "No trades yet" until the
 * refetch landed. The live search input counts too, or typing a narrowing search
 * unmounts the box.
 *
 * A project whose only DvP activity is a trade somebody else set up for it has
 * none of its own, so inbound trades also keep it from reading as empty.
 */
export function resolveTradesListState(input: {
  returned: { status: DvpTradesUrlStatus; query: string };
  chosen: { status: DvpTradesUrlStatus; query: string };
  queryInput: string;
  tradeCount: number;
  inboundCount: number;
  /** Rows on the segment showing: inbound when waiting, else trades. */
  shownCount: number;
  showingInbound: boolean;
}): { filtersApplied: boolean; filteredToNothing: boolean; listIsEmpty: boolean } {
  const filtersApplied =
    input.returned.status !== "all" ||
    input.returned.query !== "" ||
    input.chosen.status !== "all" ||
    input.chosen.query !== "" ||
    input.queryInput.trim() !== "";
  const listIsEmpty = !filtersApplied && input.tradeCount === 0 && input.inboundCount === 0;
  return {
    filtersApplied,
    listIsEmpty,
    filteredToNothing: !(listIsEmpty && !input.showingInbound) && input.shownCount === 0,
  };
}
