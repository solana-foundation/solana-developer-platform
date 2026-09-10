/**
 * The trades list's URL state.
 *
 * The URL carries `?status=<group>` where `<group>` is the UI grouping
 * key (`open` | `ready` | `closed`; `all` is absent). The server refetches per
 * navigation with the group mapped to the real statuses behind it, the
 * transactions-page pattern: filters in the URL, one parse/serialize pair as
 * the single translation, `router.replace` on change.
 *
 * `waiting` is deliberately NOT a URL state here: it selects a different
 * endpoint (the inbound list), so it lives in component state only and never
 * reaches the trades query string.
 */

import type { DvpTradeStatus } from "@sdp/types";
import type { DvpTradesFilters } from "./dvp-trades.data";

/**
 * The statuses worth filtering to, grouped the way somebody actually looks.
 *
 * Not one entry per status: `creating`, `create_failed` and the three closed
 * states are things you look for as a group ("what is finished?"), not
 * individually, and a nine-item dropdown for a list this size is a worse
 * answer than four.
 */
export const STATUS_FILTERS = {
  all: null,
  // Not a status the trade has: these belong to another organization and are
  // filtered by who they name, not by where they are in their lifecycle. It
  // shares the control because it answers the same question a reader is asking
  // of it — "which of these do I need to look at" — and a second control beside
  // the first would ask them to learn two.
  waiting: [],
  open: ["created", "partially_funded", "creating"],
  ready: ["funded"],
  closed: ["settled", "cancelled", "rejected", "closed_unknown", "create_failed", "expired"],
} as const satisfies Record<string, readonly DvpTradeStatus[] | null>;

export type StatusFilter = keyof typeof STATUS_FILTERS;

/**
 * Parses the page's search params into the filters the trades fetch takes.
 *
 * `status` accepts only the group keys — an unknown group is dropped rather
 * than 400'd, because a URL is typed by a person and the page's own control
 * cannot produce it.
 *
 * @param searchParams - The raw page search params.
 * @returns The group plus the filters for the trades API call.
 */
export function parseDvpTradesFilters(
  searchParams: Record<string, string | string[] | undefined>
): { status: StatusFilter; filters: DvpTradesFilters } {
  const rawStatus = Array.isArray(searchParams.status)
    ? searchParams.status[0]
    : searchParams.status;
  const status: StatusFilter =
    rawStatus !== undefined && rawStatus in STATUS_FILTERS ? (rawStatus as StatusFilter) : "all";

  return {
    status,
    filters: {
      statuses: STATUS_FILTERS[status] === null ? null : [...STATUS_FILTERS[status]],
    },
  };
}

/**
 * Serializes the group back into the page's query string.
 *
 * `all` and `waiting` are the absence of the param — `waiting` selects the
 * inbound segment, which the trades query never carries — so the clean URL is
 * the unfiltered one and "clear filters" is a replace with no params.
 *
 * @param status - The active status group.
 * @returns The query string with its leading `?`, or "" for the unfiltered URL.
 */
export function serializeDvpTradesFilters(
  status: "all" | "waiting" | Exclude<keyof typeof STATUS_FILTERS, "all" | "waiting">
): string {
  const query = new URLSearchParams();
  if (status !== "all" && status !== "waiting") {
    query.set("status", status);
  }
  const encoded = query.toString();
  return encoded === "" ? "" : `?${encoded}`;
}
