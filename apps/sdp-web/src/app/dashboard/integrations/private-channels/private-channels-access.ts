import { auth } from "@clerk/nextjs/server";
import { hasPermission, type Permission } from "@sdp/types";
import { notFound, redirect } from "next/navigation";
import { privateChannels } from "@/flags";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import {
  PRIVATE_CHANNELS_OVERVIEW_PATH,
  PRIVATE_CHANNELS_SETUP_PATH,
} from "./private-channels-routes";

/**
 * Flag + auth gate shared by every Private Channels page.
 *
 * The flag check runs first so a hand-typed URL 404s without spending an
 * authenticated round trip, matching the segment layout's ordering. Both
 * `notFound()` and `redirect()` throw, so callers can treat a normal return as
 * "the caller is allowed to render".
 */
export async function requirePrivateChannelsAccess(permission?: Permission): Promise<void> {
  if (!(await privateChannels())) {
    notFound();
  }

  const { userId, orgId, orgRole } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }
  if (permission && !hasPermission(resolveDashboardAccess(orgRole).permissions, permission)) {
    redirect(PRIVATE_CHANNELS_OVERVIEW_PATH);
  }
}

// Re-exported so server pages keep a single import for gate + redirect targets.
// The literals themselves live in an import-free module because client
// components need them too — see private-channels-routes.ts.
export { PRIVATE_CHANNELS_OVERVIEW_PATH, PRIVATE_CHANNELS_SETUP_PATH };
