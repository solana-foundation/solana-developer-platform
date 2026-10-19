"use client";

import type { AssetAuditActorType, AssetAuditEvent, AssetAuditStatus } from "@sdp/types/audit";
import type { StatusTone } from "@sdp/ui/status-text";
import { useState } from "react";
import useSWR from "swr";
import useSWRInfinite from "swr/infinite";
import type { MessageKey } from "@/i18n/messages";
import type { useTranslations } from "@/i18n/provider";
import { usePagedList } from "@/lib/use-paged-list";
import { issuanceQueryKeys } from "../../issuance-query-key";
import { type AssetAuditHistory, fetchAssetAuditHistory } from "../asset-profile/asset-audit.data";

type Translate = ReturnType<typeof useTranslations>;

export interface TokenActivityQuery {
  page: number;
  pageSize: number;
  action?: string;
  status?: AssetAuditStatus;
  actorType?: AssetAuditActorType;
}

/** One page of the token's audit history: what was done to it, by whom, and how it went. */
export function useTokenActivity(tokenId: string, query: TokenActivityQuery) {
  return useSWR<AssetAuditHistory, Error>(
    issuanceQueryKeys.tokenActivity({ tokenId, ...query }),
    () =>
      fetchAssetAuditHistory(tokenId, {
        page: query.page,
        pageSize: query.pageSize,
        action: query.action ?? null,
        status: query.status ?? null,
        actorType: query.actorType ?? null,
      }),
    { keepPreviousData: true, revalidateOnFocus: true }
  );
}

/** How many events the activity tab reads at a time. */
export const TOKEN_ACTIVITY_WINDOW = 100;

/**
 * The token's audit history read 100 events at a time, newest first: the tab searches and
 * pages what is loaded, and `loadOlder` reads the next window while `hasMore` says the API
 * holds older events. A window that fails to load keeps the ones before it (`olderFailed`),
 * and `loadOlder` then retries it; a failed refresh of the loaded windows keeps them on screen
 * and says so (`refreshFailed`).
 */
export function useTokenActivityWindows(
  tokenId: string,
  filters: Omit<TokenActivityQuery, "page" | "pageSize">
) {
  const { data, error, size, setSize, isValidating, mutate } = useSWRInfinite<
    AssetAuditHistory,
    Error
  >(
    (index, previous) =>
      previous && !previous.hasMore
        ? null
        : issuanceQueryKeys.tokenActivity({
            tokenId,
            page: index + 1,
            pageSize: TOKEN_ACTIVITY_WINDOW,
            ...filters,
          }),
    (key) => {
      const page = issuanceQueryKeys.tokenActivityPage(key);
      if (page === null) throw new Error("The activity read was given a key that is not a window");
      return fetchAssetAuditHistory(tokenId, {
        page,
        pageSize: TOKEN_ACTIVITY_WINDOW,
        action: filters.action ?? null,
        status: filters.status ?? null,
        actorType: filters.actorType ?? null,
      });
    },
    { revalidateOnFocus: true, revalidateFirstPage: true }
  );
  const events = data?.flatMap((window) => window.events) ?? [];
  const hasMore = data?.at(-1)?.hasMore === true;
  const loadedWindows = data?.length ?? 0;
  const loadingOlder = isValidating && size > loadedWindows;
  return {
    events,
    loaded: data !== undefined,
    // Nothing to show: the newest window itself failed.
    error: loadedWindows === 0 ? error : undefined,
    olderFailed: loadedWindows > 0 && error !== undefined && size > loadedWindows,
    refreshFailed: loadedWindows > 0 && error !== undefined && size <= loadedWindows,
    retry: () => mutate(),
    hasMore,
    loadingOlder,
    loadOlder: () => (size > loadedWindows ? mutate() : setSize(size + 1)),
  };
}

const ACTION_LABEL = {
  deploy: "DashboardIssuance.newDesign.activity.events.deploy",
  mint: "DashboardIssuance.newDesign.activity.events.mint",
  burn: "DashboardIssuance.newDesign.activity.events.burn",
  freeze: "DashboardIssuance.newDesign.activity.events.freeze",
  unfreeze: "DashboardIssuance.newDesign.activity.events.unfreeze",
  seize: "DashboardIssuance.newDesign.activity.events.seize",
  force_burn: "DashboardIssuance.newDesign.activity.events.forceBurn",
  update_authority: "DashboardIssuance.newDesign.activity.events.updateAuthority",
  pause: "DashboardIssuance.newDesign.activity.events.pause",
  unpause: "DashboardIssuance.newDesign.activity.events.unpause",
  create: "DashboardIssuance.newDesign.activity.events.create",
  update: "DashboardIssuance.newDesign.activity.events.update",
  revoke: "DashboardIssuance.newDesign.activity.events.revoke",
} as const satisfies Record<string, MessageKey>;

export const ACTIVITY_ACTIONS: readonly string[] = Object.keys(ACTION_LABEL);

/**
 * A control list change, which the API logs as `create` or `revoke` on the list entry rather
 * than on the token: read on its own, `create` would say the token was created.
 */
const LIST_ACTION_LABEL = {
  create: "DashboardIssuance.newDesign.activity.events.listAdd",
  revoke: "DashboardIssuance.newDesign.activity.events.listRemove",
} as const satisfies Record<string, MessageKey>;

function isListAction(action: string): action is keyof typeof LIST_ACTION_LABEL {
  return Object.hasOwn(LIST_ACTION_LABEL, action);
}

function isKnownAction(action: string): action is keyof typeof ACTION_LABEL {
  return Object.hasOwn(ACTION_LABEL, action);
}

export function activityEventLabel(action: string, t: Translate, resourceType?: string): string {
  if (resourceType === "token_allowlist" && isListAction(action))
    return t(LIST_ACTION_LABEL[action]);
  if (isKnownAction(action)) return t(ACTION_LABEL[action]);
  // An event the catalog has no words for reads in sentence case, as the named ones do.
  const words = action.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function activityActorType(actorType: AssetAuditActorType, t: Translate) {
  switch (actorType) {
    case "api_key":
      return t("DashboardIssuance.newDesign.activity.actorApiKey");
    case "system":
      return t("DashboardIssuance.newDesign.activity.actorSystem");
    case "user":
      return t("DashboardIssuance.newDesign.activity.actorMember");
    default: {
      const unhandled: never = actorType;
      return unhandled;
    }
  }
}

export function activityStatus(
  status: AssetAuditStatus,
  t: Translate
): { label: string; tone: StatusTone } {
  switch (status) {
    case "failure":
      return { label: t("DashboardIssuance.newDesign.activity.failed"), tone: "critical" };
    case "success":
      return { label: t("DashboardIssuance.newDesign.activity.success"), tone: "positive" };
    default: {
      const unhandled: never = status;
      return unhandled;
    }
  }
}

/** The event's on-chain signature, where the audit record carries one. */
export function activitySignature(event: Pick<AssetAuditEvent, "metadata">): string | null {
  const signature = event.metadata?.signature;
  return typeof signature === "string" && signature ? signature : null;
}

/** How many events the activity tab shows at a time. */
export const ACTIVITY_PAGE_SIZE = 25;

export interface ActivityFilters {
  action?: string;
  actorType?: AssetAuditActorType;
  status?: AssetAuditStatus;
}

/**
 * The activity tab's behavior: the audit filters (read by the API), a text search over what is
 * loaded (the API has none), and the page of matching events. A change to a filter or the
 * search goes back to the first page.
 */
export function useTokenActivityFeed(tokenId: string, t: Translate) {
  const [filters, setFilters] = useState<ActivityFilters>({});
  const [search, setSearch] = useState("");
  const history = useTokenActivityWindows(tokenId, filters);
  const needle = search.trim().toLowerCase();
  const events = history.events.filter(
    (event) =>
      !needle ||
      [
        activityEventLabel(event.action, t, event.resourceType),
        event.actorLabel,
        activityStatus(event.status, t).label,
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle)
  );
  const paging = usePagedList(events, ACTIVITY_PAGE_SIZE);
  return {
    history,
    filters,
    search,
    needle,
    events,
    ...paging,
    updateFilters: (changes: ActivityFilters) => {
      setFilters((current) => ({ ...current, ...changes }));
      paging.reset();
    },
    changeSearch: (value: string) => {
      setSearch(value);
      paging.reset();
    },
    clearAll: () => {
      setFilters({});
      setSearch("");
      paging.reset();
    },
  };
}
