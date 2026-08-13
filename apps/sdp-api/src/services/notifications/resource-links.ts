// Deep-link targets for email CTAs: (resource_type, resource_id) → dashboard URL.
// This hardcodes web routes in the API — the unavoidable cost of links in email.
// Keep the map tiny and in lockstep with the bell's hrefFor map in
// apps/sdp-web/src/components/notification-bell.tsx.

import type { Env } from "@/types/env";

function frontendBase(env: Env): string | null {
  const base = env.FRONTEND_URL?.replace(/\/$/, "");
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
      return `${base}/dashboard/payments`;
    case "recurring_payment":
      return `${base}/dashboard/payments/recurring`;
    case "counterparty":
      return `${base}/dashboard/payments/counterparty`;
    default:
      return null;
  }
}

export function managePreferencesLink(env: Env): string | null {
  const base = frontendBase(env);
  return base ? `${base}/dashboard/settings` : null;
}
