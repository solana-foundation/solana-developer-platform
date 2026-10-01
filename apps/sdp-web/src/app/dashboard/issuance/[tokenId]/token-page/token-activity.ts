"use client";

import type { AssetAuditEvent } from "@sdp/types";
import useSWR from "swr";
import useSWRInfinite from "swr/infinite";
import type { StatusTone } from "@/components/ui/status-text";
import type { MessageKey } from "@/i18n/messages";
import type { useTranslations } from "@/i18n/provider";
import { type AssetAuditHistory, fetchAssetAuditHistory } from "../asset-profile/asset-audit.data";

type Translate = ReturnType<typeof useTranslations>;

export const TOKEN_ACTIVITY_KEY = "token-activity-redesign";

export interface TokenActivityQuery {
  page: number;
  pageSize: number;
  action?: string;
  status?: string;
  actorType?: string;
}

/** One page of the token's audit history: what was done to it, by whom, and how it went. */
export function useTokenActivity(tokenId: string, query: TokenActivityQuery) {
  return useSWR<AssetAuditHistory, Error>(
    [
      TOKEN_ACTIVITY_KEY,
      tokenId,
      query.page,
      query.pageSize,
      query.action,
      query.status,
      query.actorType,
    ],
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
 * holds older events.
 */
export function useTokenActivityWindows(
  tokenId: string,
  filters: Omit<TokenActivityQuery, "page" | "pageSize">
) {
  const { data, error, size, setSize, isValidating } = useSWRInfinite<AssetAuditHistory, Error>(
    (index, previous) =>
      previous && !previous.hasMore
        ? null
        : [
            TOKEN_ACTIVITY_KEY,
            tokenId,
            index + 1,
            TOKEN_ACTIVITY_WINDOW,
            filters.action,
            filters.status,
            filters.actorType,
          ],
    ([, , page]) =>
      fetchAssetAuditHistory(tokenId, {
        page: page as number,
        pageSize: TOKEN_ACTIVITY_WINDOW,
        action: filters.action ?? null,
        status: filters.status ?? null,
        actorType: filters.actorType ?? null,
      }),
    { revalidateOnFocus: true, revalidateFirstPage: true }
  );
  const events = data?.flatMap((window) => window.events) ?? [];
  const hasMore = data?.at(-1)?.hasMore === true;
  const loadingOlder = isValidating && size > (data?.length ?? 0);
  return {
    events,
    loaded: data !== undefined,
    error,
    hasMore,
    loadingOlder,
    loadOlder: () => setSize(size + 1),
  };
}

const ACTION_LABEL: Record<string, MessageKey> = {
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
};

export const ACTIVITY_ACTIONS = Object.keys(ACTION_LABEL);

export function activityEventLabel(action: string, t: Translate): string {
  const key = ACTION_LABEL[action];
  return key ? t(key) : action.replaceAll("_", " ");
}

export function activityActorType(event: Pick<AssetAuditEvent, "actorType">, t: Translate) {
  return t(
    event.actorType === "api_key"
      ? "DashboardIssuance.newDesign.activity.actorApiKey"
      : event.actorType === "system"
        ? "DashboardIssuance.newDesign.activity.actorSystem"
        : "DashboardIssuance.newDesign.activity.actorMember"
  );
}

export function activityStatus(
  event: Pick<AssetAuditEvent, "status">,
  t: Translate
): { label: string; tone: StatusTone } {
  return event.status === "failure"
    ? { label: t("DashboardIssuance.newDesign.activity.failed"), tone: "critical" }
    : { label: t("DashboardIssuance.newDesign.activity.success"), tone: "positive" };
}

/** The event's on-chain signature, where the audit record carries one. */
export function activitySignature(event: Pick<AssetAuditEvent, "metadata">): string | null {
  const signature = event.metadata?.signature;
  return typeof signature === "string" && signature ? signature : null;
}
