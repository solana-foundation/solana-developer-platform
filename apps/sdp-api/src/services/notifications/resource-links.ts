// Deep-link targets for email CTAs: (resource_type, resource_id) → dashboard URL.
// This hardcodes web routes in the API — the unavoidable cost of links in email.
// Keep the map tiny and in lockstep with the bell's hrefFor map in
// apps/sdp-web/src/components/notification-bell.tsx.

import { getLogger } from "@/runtime/logger";
import type { Env } from "@/types/env";

let warnedMissingFrontendUrl = false;

function frontendBase(env: Env): string | null {
  const base = env.FRONTEND_URL?.replace(/\/+$/, "");
  if (!base && !warnedMissingFrontendUrl) {
    warnedMissingFrontendUrl = true;
    // Without a base URL every email ships with no CTA and no manage-preferences
    // footer — a recipient has no in-email path to stop the mail. Loud once, not fatal.
    getLogger().warn("FRONTEND_URL is unset: notification emails carry no links");
  }
  return base || null;
}

export function resourceLink(
  env: Env,
  params: {
    resourceType: string | null | undefined;
    resourceId: string | null | undefined;
    // Notification type, for route variants (workflow types land on the workflows tab).
    type?: string;
  }
): string | null {
  const base = frontendBase(env);
  if (!base || !params.resourceType) {
    return null;
  }
  switch (params.resourceType) {
    case "token": {
      if (!params.resourceId) return null;
      const tab = params.type?.startsWith("workflow_") ? "?tab=workflows" : "";
      return `${base}/dashboard/issuance/${encodeURIComponent(params.resourceId)}${tab}`;
    }
    case "member":
    case "invitation":
      return `${base}/dashboard/members`;
    case "payment_transfer":
      // The transfer list lives on the transactions sub-page, not the payments hub.
      return `${base}/dashboard/payments/transactions`;
    case "recurring_payment":
      return params.resourceId
        ? `${base}/dashboard/payments/recurring/${encodeURIComponent(params.resourceId)}`
        : `${base}/dashboard/payments/recurring`;
    case "counterparty":
      return params.resourceId
        ? `${base}/dashboard/payments/counterparty/${encodeURIComponent(params.resourceId)}`
        : `${base}/dashboard/payments/counterparty`;
    default:
      return null;
  }
}

export function managePreferencesLink(env: Env): string | null {
  const base = frontendBase(env);
  // The fragment lands on the notifications card (it is the last of four sections on
  // the settings page); the card carries the matching id.
  return base ? `${base}/dashboard/settings#notifications` : null;
}
