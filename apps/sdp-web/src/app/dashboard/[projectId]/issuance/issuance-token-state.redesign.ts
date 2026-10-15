import type { StatusTone } from "@/components/ui/status-text";
import type { MessageKey } from "@/i18n/messages";

/**
 * Where a token is in its life, as the design names it. The API stores only pending, active,
 * paused and revoked, so a deploy in flight and a deploy that failed come from the token's
 * latest deploy transaction, which the token's page and the list both read.
 */
export type TokenLifecycle = "draft" | "deploying" | "failed" | "live" | "paused" | "revoked";

interface TokenLifecycleShape {
  mintAddress: string | null;
  deployedAt?: string | null;
  status: string;
}

/** The latest deploy transaction's status, where the page has read it. */
export type DeployAttemptStatus = "pending" | "processing" | "confirmed" | "finalized" | "failed";

/**
 * The token's lifecycle state.
 *
 * @param token - The token's mint address, deploy time and stored status.
 * @param latestDeploy - The status of its latest deploy transaction, when known.
 * @returns The state the design shows.
 */
export function tokenLifecycle(
  token: TokenLifecycleShape,
  latestDeploy?: DeployAttemptStatus | null
): TokenLifecycle {
  if (!(token.mintAddress || token.deployedAt)) {
    if (latestDeploy === "pending" || latestDeploy === "processing") return "deploying";
    if (latestDeploy === "failed") return "failed";
    return "draft";
  }
  if (token.status === "revoked") return "revoked";
  if (token.status === "paused") return "paused";
  return "live";
}

/** Whether the mint exists on chain. */
export function isOnChain(state: TokenLifecycle): boolean {
  return state === "live" || state === "paused" || state === "revoked";
}

export const TOKEN_LIFECYCLE_TONE: Record<TokenLifecycle, StatusTone> = {
  draft: "neutral",
  deploying: "progress",
  failed: "critical",
  live: "positive",
  paused: "attention",
  revoked: "neutral",
};

/** The state band's tone for a lifecycle state (refresh-record's StateBand). */
export const TOKEN_LIFECYCLE_BAND: Record<
  TokenLifecycle,
  "ok" | "warn" | "error" | "info" | "neutral"
> = {
  draft: "neutral",
  deploying: "info",
  failed: "error",
  live: "ok",
  paused: "warn",
  revoked: "neutral",
};

export const TOKEN_LIFECYCLE_LABEL: Record<TokenLifecycle, MessageKey> = {
  draft: "DashboardIssuance.newDesign.state.draft",
  deploying: "DashboardIssuance.newDesign.state.deploying",
  failed: "DashboardIssuance.newDesign.state.failed",
  live: "DashboardIssuance.newDesign.state.live",
  paused: "DashboardIssuance.newDesign.state.paused",
  revoked: "DashboardIssuance.newDesign.state.revoked",
};

/** What the state means, the line under it on the token's page. */
export const TOKEN_LIFECYCLE_WHY: Record<TokenLifecycle, MessageKey> = {
  draft: "DashboardIssuance.newDesign.state.draftWhy",
  deploying: "DashboardIssuance.newDesign.state.deployingWhy",
  failed: "DashboardIssuance.newDesign.state.failedWhy",
  live: "DashboardIssuance.newDesign.state.liveWhy",
  paused: "DashboardIssuance.newDesign.state.pausedWhy",
  revoked: "DashboardIssuance.newDesign.state.revokedWhy",
};

/** "Sep 2, 2026", the design's day format. */
export function formatTokenDay(iso: string | null | undefined, locale: string): string | null {
  if (!iso) return null;
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return null;
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(time);
}

/** The day and, apart, the time: "Sep 13, 2026" over "3:00 PM". */
export function formatTokenMoment(
  iso: string | null | undefined,
  locale: string
): { day: string; time: string } | null {
  if (!iso) return null;
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return null;
  return {
    day: new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(time),
    time: new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(time),
  };
}
