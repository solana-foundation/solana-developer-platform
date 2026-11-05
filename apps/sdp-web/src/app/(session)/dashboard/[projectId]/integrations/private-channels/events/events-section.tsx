"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@sdp/ui/card";
import { PrivateChannelsLoadError } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-load-error";
import {
  usePrivateChannelEventReferences,
  usePrivateChannelEvents,
} from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-reads";
import { PrivateChannelsListSkeleton } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-route-skeletons";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import { useDashboardKeyScope } from "@/lib/dashboard-swr";
import { EventsList } from "./events-list";

export function EventsSection() {
  const t = useTranslations();
  const { projectId } = useDashboardKeyScope();
  const canViewRawPayload =
    useDashboardWorkspace().dashboardAccess.capabilities.canManageOrgSettings;
  const events = usePrivateChannelEvents();
  const references = usePrivateChannelEventReferences();

  if (events.data === undefined && events.error === undefined) {
    return <PrivateChannelsListSkeleton maxWidth="max-w-5xl" />;
  }
  return (
    <div className="mx-auto w-full max-w-5xl">
      <Card>
        <CardHeader>
          <CardTitle>{t("DashboardPrivateChannels.events.title")}</CardTitle>
          <CardDescription>{t("DashboardPrivateChannels.events.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          {events.data === undefined ? (
            <PrivateChannelsLoadError
              message={events.error?.message}
              onRetry={() => void events.mutate()}
            />
          ) : (
            <EventsList
              // A newer event at the head reseeds the feed; older pages it loaded are then stale.
              key={events.data.events[0]?.id ?? "empty"}
              projectId={projectId}
              initialEvents={events.data.events}
              initialHasMore={events.data.hasMore}
              initialNextCursor={events.data.nextCursor}
              canViewRawPayload={canViewRawPayload}
              names={references.data}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
