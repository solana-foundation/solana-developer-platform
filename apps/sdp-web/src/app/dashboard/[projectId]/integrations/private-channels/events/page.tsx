import { organizationRoleMayPerform } from "@sdp/types/actions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@sdp/ui/card";
import { requirePrivateChannelsAccess } from "@/app/dashboard/[projectId]/integrations/private-channels/private-channels-access";
import { PrivateChannelsLoadError } from "@/app/dashboard/[projectId]/integrations/private-channels/private-channels-load-error";
import {
  loadEventReferences,
  loadEvents,
} from "@/app/dashboard/[projectId]/integrations/private-channels/private-channels-page.data";
import { getTranslations } from "@/i18n/server";
import { createSdpApiClient, requestMemberRole, requestProjectId } from "@/lib/sdp-api";
import { EventsList } from "./events-list";

export default async function PrivateChannelsEventsPage() {
  await requirePrivateChannelsAccess();

  // The same request-scoped resolution the client used: the scope the initial
  // rows were loaded under. Follow-up loads answer for the same URL Project and
  // are checked against it, so the feed can never mix projects.
  const [t, role, client, projectId] = await Promise.all([
    getTranslations(),
    requestMemberRole(),
    createSdpApiClient(),
    requestProjectId(),
  ]);
  const canViewRawPayload = organizationRoleMayPerform(role, "organizations.manage");
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
              projectId={projectId}
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
