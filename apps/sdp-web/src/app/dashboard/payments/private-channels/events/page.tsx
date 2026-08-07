import { auth } from "@clerk/nextjs/server";
import { hasPermission } from "@sdp/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getTranslations } from "@/i18n/server";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { createSdpApiClient } from "@/lib/sdp-api";
import { requirePrivateChannelsAccess } from "../private-channels-access";
import { PrivateChannelsLoadError } from "../private-channels-load-error";
import { loadEventReferences, loadEvents } from "../private-channels-page.data";
import { EventsList } from "./events-list";

export default async function PrivateChannelsEventsPage() {
  await requirePrivateChannelsAccess();

  const [t, { orgRole }] = await Promise.all([getTranslations(), auth()]);
  const { permissions } = resolveDashboardAccess(orgRole);
  const canViewRawPayload = hasPermission(permissions, "org:admin");

  const client = await createSdpApiClient();
  const [events, references] = await Promise.all([loadEvents(client), loadEventReferences(client)]);

  return (
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
              names={references.data}
            />
          ) : (
            <PrivateChannelsLoadError message={events.error} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
