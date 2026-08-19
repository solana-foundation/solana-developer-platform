import { auth } from "@clerk/nextjs/server";
import type { NotificationPreferenceDto, NotificationPreferencesResponse } from "@sdp/types";
import { redirect } from "next/navigation";
import { assetProfiles } from "@/flags";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { isDeveloperControlsEnabled } from "@/lib/developer-controls";
import { createTimedTrace } from "@/lib/request-tracing";
import { createOrgSdpApiClient } from "@/lib/sdp-api";
import { AppearanceSection } from "./appearance-section";
import { MembersSection } from "./members-section";
import { NotificationsSection } from "./notifications-section";

/** Anything that is not a positive integer falls back to the first page. */
function resolveMembersPage(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

type NotificationPreferencesState = {
  preferences: NotificationPreferenceDto[];
  loadError: boolean;
};

/**
 * The notification matrix is the only thing this page still fetches, and it owns its
 * whole failure path: a section-local error, never a page-level one. Self-contained
 * (its own client and trace, resolved to a total shape rather than `| null`) so the
 * page body stays the flag-and-render function the RPC removal left behind.
 */
async function loadNotificationPreferences(): Promise<NotificationPreferencesState> {
  const trace = createTimedTrace("dashboard.settings.notification-preferences");
  try {
    const apiClient = await createOrgSdpApiClient(trace.childContext("api"));
    const response = await trace.step("fetch_notification_preferences", () =>
      apiClient.fetch<NotificationPreferencesResponse>("/v1/notifications/preferences")
    );
    trace.log({ ok: true, preferenceCount: response.preferences.length });
    return { preferences: response.preferences, loadError: false };
  } catch (error) {
    trace.log({ ok: false, error: error instanceof Error ? error.message : "Unknown error" });
    return { preferences: [], loadError: true };
  }
}

/**
 * RPC selection used to live here (HOO-787). It is managed on each provider's
 * page under Integrations now, which is also where the fallback warning for a
 * provider the deployment no longer offers is raised — so this page no longer
 * loads the organization or its provider availability at all.
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const membersPage = resolveMembersPage((await searchParams).membersPage);

  const [{ userId, orgId, orgRole }, assetProfilesEnabled] = await Promise.all([
    auth(),
    assetProfiles(),
  ]);
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const dashboardAccess = resolveDashboardAccess(orgRole);
  const notificationPreferences = await loadNotificationPreferences();

  return (
    <div className="w-full flex flex-col gap-6">
      {/* canManageOrgSettings resolves to org:write, which is what inviting a
          member requires. */}
      {dashboardAccess.capabilities.canManageOrgSettings ? (
        <MembersSection page={membersPage} />
      ) : null}

      {/* Not permission-gated: the colour theme is a per-device personal preference,
          not organization state, so every role gets to set it. */}
      {/* The asset-header controls tune a surface that is itself still behind the
          asset-profiles flag, and they are ours to tune rather than a customer
          setting — so they only appear where both hold. */}
      <AppearanceSection
        showAssetHeaderControls={
          assetProfilesEnabled &&
          isDeveloperControlsEnabled({
            nodeEnvironment: process.env.NODE_ENV,
            sdpEnvironment: process.env.NEXT_PUBLIC_SDP_ENVIRONMENT,
            vercelEnvironment: process.env.VERCEL_ENV,
          })
        }
      />

      {/* Not permission-gated either: a member's own notification matrix is personal
          state, same rationale as the appearance section above. */}
      <NotificationsSection
        preferences={notificationPreferences.preferences}
        loadError={notificationPreferences.loadError}
      />
    </div>
  );
}
