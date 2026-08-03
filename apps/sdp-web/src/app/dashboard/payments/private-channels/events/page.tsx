import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getTranslations } from "@/i18n/server";
import { createSdpApiClient } from "@/lib/sdp-api";
import { requirePrivateChannelsAccess } from "../private-channels-access";
import { PrivateChannelsLoadError } from "../private-channels-load-error";
import { loadEvents } from "../private-channels-page.data";
import { EventsList } from "./events-list";

export default async function PrivateChannelsEventsPage() {
  await requirePrivateChannelsAccess();

  const t = await getTranslations();

  const client = await createSdpApiClient();
  const events = await loadEvents(client);

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
            />
          ) : (
            <PrivateChannelsLoadError message={events.error} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
