import { type Action, actionVerbOf } from "@sdp/types/actions";
import type { ApiKeyEnvironment, ApiKeyStatus, ApiKeyWalletScope } from "@sdp/types/api-keys";
import type { useTranslations } from "@/i18n/provider";
import { formatDate } from "@/lib/date-format";

type Translate = ReturnType<typeof useTranslations>;

export interface ApiKeyListItem {
  id: string;
  name: string;
  description: string | null;
  keyPrefix: string;
  grants: Action[];
  environment: ApiKeyEnvironment;
  status: ApiKeyStatus;
  walletScope: ApiKeyWalletScope;
  /** Custody wallet ids a selected key lists. */
  walletIds: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  /** When a rotated key stops working; null unless it is in its grace period. */
  rotationDeadline: string | null;
  createdAt: string;
}

export interface ApiKeyDetails extends ApiKeyListItem {
  /** Null: the key may be used from any address. */
  allowedIps: string[] | null;
  /** The key this one replaced by rotation. */
  rotatedFrom: string | null;
}

/**
 * When the key stops working and why. A rotated key stays `active` in its row while
 * authentication refuses it past its deadline, so the deadline itself decides.
 */
export type ApiKeyLifetime =
  | { kind: "never" }
  | { kind: "until"; at: string }
  | { kind: "soon"; at: string }
  | { kind: "stopping"; at: string }
  | { kind: "ended"; at: string | null };

const SOON_MS = 7 * 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function timeOf(iso: string): number {
  return new Date(iso).getTime();
}

export function apiKeyLifetime(key: ApiKeyListItem, now: number): ApiKeyLifetime {
  if (key.status !== "active") {
    return { kind: "ended", at: key.expiresAt };
  }
  const expiresAt = key.expiresAt;
  const deadline = key.rotationDeadline;
  if (deadline !== null && (expiresAt === null || timeOf(deadline) <= timeOf(expiresAt))) {
    return timeOf(deadline) > now
      ? { kind: "stopping", at: deadline }
      : { kind: "ended", at: deadline };
  }
  if (expiresAt === null) {
    return { kind: "never" };
  }
  const left = timeOf(expiresAt) - now;
  if (left <= 0) return { kind: "ended", at: expiresAt };
  return left <= SOON_MS ? { kind: "soon", at: expiresAt } : { kind: "until", at: expiresAt };
}

/** Whether the key still authenticates. */
export function isApiKeyLive(lifetime: ApiKeyLifetime): boolean {
  return lifetime.kind !== "ended";
}

/** "18 h", "40 min", "3 days": the time left until `at`, at the coarsest unit that reads well. */
function durationUntil(at: string, now: number, t: Translate): string {
  const left = Math.max(0, timeOf(at) - now);
  if (left < HOUR_MS) {
    return t("DashboardCustody.apiKeyPage.minutes", {
      count: Math.max(1, Math.ceil(left / MINUTE_MS)),
    });
  }
  if (left < DAY_MS) {
    return t("DashboardCustody.apiKeyPage.hours", { count: Math.ceil(left / HOUR_MS) });
  }
  const days = Math.ceil(left / DAY_MS);
  return days === 1
    ? t("DashboardCustody.apiKeyPage.dayOne")
    : t("DashboardCustody.apiKeyPage.days", { count: days });
}

/** The list's Expires cell and the detail page's lifetime line. */
export function formatApiKeyLifetime(
  lifetime: ApiKeyLifetime,
  now: number,
  locale: string,
  timeZone: string,
  t: Translate
): string {
  switch (lifetime.kind) {
    case "never":
      return t("DashboardCustody.apiKeyPage.noExpiry");
    case "until":
      return formatDate(locale, timeZone, lifetime.at) ?? lifetime.at;
    case "soon":
      return t("DashboardCustody.apiKeyPage.expiresIn", {
        duration: durationUntil(lifetime.at, now, t),
      });
    case "stopping":
      return t("DashboardCustody.apiKeyPage.stopsWorkingIn", {
        duration: durationUntil(lifetime.at, now, t),
      });
    case "ended":
      return lifetime.at
        ? t("DashboardCustody.apiKeyPage.expiredOn", {
            date: formatDate(locale, timeZone, lifetime.at) ?? lifetime.at,
          })
        : t("DashboardCustody.apiKeyPage.expired");
    default: {
      const exhaustive: never = lifetime;
      throw new Error(`Unknown API key lifetime: ${String(exhaustive)}`);
    }
  }
}

/** "40 min ago", "2 h ago", then the day; "Never used" for a key nothing has called with. */
export function formatLastUsed(
  lastUsedAt: string | null,
  now: number,
  locale: string,
  timeZone: string,
  t: Translate
): string {
  if (!lastUsedAt) return t("DashboardCustody.apiKeyPage.neverUsed");
  const ago = Math.max(0, now - timeOf(lastUsedAt));
  if (ago < HOUR_MS) {
    return t("DashboardCustody.apiKeyPage.minutesAgo", {
      count: Math.max(1, Math.floor(ago / MINUTE_MS)),
    });
  }
  if (ago < DAY_MS) {
    return t("DashboardCustody.apiKeyPage.hoursAgo", { count: Math.floor(ago / HOUR_MS) });
  }
  return formatDate(locale, timeZone, lastUsedAt) ?? lastUsedAt;
}

/** How much a key may do, at a glance: moving funds is the line that matters. */
export type ApiKeyReach = "read" | "write" | "funds";

export const API_KEY_REACHES = ["read", "write", "funds"] as const satisfies readonly ApiKeyReach[];

export function apiKeyReach(grants: readonly Action[]): ApiKeyReach {
  const verbs = grants.map(actionVerbOf);
  if (verbs.includes("execute")) return "funds";
  return verbs.every((verb) => verb === "read") ? "read" : "write";
}

export function apiKeyReachLabel(reach: ApiKeyReach, t: Translate): string {
  return t(`DashboardCustody.apiKeyPage.reach.${reach}`);
}

export function walletCountLabel(count: number, t: Translate): string {
  return count === 1
    ? t("DashboardCustody.apiKeyPage.walletCountOne")
    : t("DashboardCustody.apiKeyPage.walletCount", { count });
}

export function apiKeyWalletsLabel(key: ApiKeyListItem, t: Translate): string {
  return key.walletScope === "all"
    ? t("DashboardCustody.allWallets")
    : walletCountLabel(key.walletIds.length, t);
}

export function apiKeyEnvironmentLabel(environment: ApiKeyEnvironment, t: Translate): string {
  return t(`DashboardCustody.apiKeyPage.environment.${environment}`);
}

/** The status filter's answers, from what the key's row and lifetime say. */
export type ApiKeyStatusFilter = "active" | "replaced" | "expired";

export const API_KEY_STATUS_FILTERS = [
  "active",
  "replaced",
  "expired",
] as const satisfies readonly ApiKeyStatusFilter[];

export function apiKeyStatusFilter(lifetime: ApiKeyLifetime): ApiKeyStatusFilter {
  if (lifetime.kind === "ended") return "expired";
  return lifetime.kind === "stopping" ? "replaced" : "active";
}

/** The grace periods the rotate panel offers, in hours; the API takes 0 to 168. */
export const API_KEY_ROTATION_GRACE_HOURS = [168, 24, 1, 0] as const;

export type ApiKeyRotationGraceHours = (typeof API_KEY_ROTATION_GRACE_HOURS)[number];

/** The expiry choices a key is created or edited with, in days; null never expires. */
export const API_KEY_EXPIRY_DAYS = [30, 90, 180, 365, null] as const;

export type ApiKeyExpiryDays = (typeof API_KEY_EXPIRY_DAYS)[number];

export function expiryFromDays(days: number, now: number): string {
  return new Date(now + days * DAY_MS).toISOString();
}

/** "keep" holds an edited key's current expiry; a number of days or null sets a new one. */
export type ApiKeyExpiryChoice = "keep" | ApiKeyExpiryDays;

export function resolveExpiryChoice(
  choice: ApiKeyExpiryChoice,
  current: string | null,
  now: number
): string | null {
  if (choice === "keep") return current;
  return choice === null ? null : expiryFromDays(choice, now);
}
