import { auth } from "@clerk/nextjs/server";
import { hasPermission } from "@sdp/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getTranslations } from "@/i18n/server";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { createSdpApiClient } from "@/lib/sdp-api";
import { requirePrivateChannelsAccess } from "../private-channels-access";
import { PrivateChannelsLoadError } from "../private-channels-load-error";
import { loadEvents } from "../private-channels-page.data";
import { EventsList } from "./events-list";

export default async function PrivateChannelsEventsPage() {
  await requirePrivateChannelsAccess();

  const [t, { orgRole }] = await Promise.all([getTranslations(), auth()]);
  const { permissions } = resolveDashboardAccess(orgRole);
  const canViewRawPayload = hasPermission(permissions, "org:admin");

  const client = await createSdpApiClient();
  const events = await loadEvents(client);

  return (
    // Payments routes are viewport-locked (see dashboard-shell): the segment renders in an
    // `overflow-hidden` box with the shell's usual padding dropped. Re-add side/bottom
    // padding and let this page scroll its own content so a long events list stays
    // reachable instead of overflowing the viewport.
    <div className="h-full min-h-0 w-full overflow-y-auto px-3 pt-2 pb-5 md:px-6 md:pb-6">
      <div className="mx-auto w-full max-w-5xl">
        <Card>
          <CardHeader>
            <CardTitle>{t("DashboardPrivateChannels.events.title")}</CardTitle>
            <CardDescription>{t("DashboardPrivateChannels.events.description")}</CardDescription>
          </CardHeader>
          <CardContent>
            {events.ok ? (
              <EventsList
                initialEvents={events.data.events}
                initialHasMore={events.data.hasMore}
                initialNextCursor={events.data.nextCursor}
                canViewRawPayload={canViewRawPayload}
              />
            ) : (
              <PrivateChannelsLoadError message={events.error} />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
