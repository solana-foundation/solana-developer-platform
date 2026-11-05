"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@sdp/ui/card";
import { PrivateChannelsInstanceGate } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-instance-gate";
import { PrivateChannelsLoadError } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-load-error";
import { usePrivateChannels } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-reads";
import { PrivateChannelsListSkeleton } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-route-skeletons";
import { useCanWrite } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import { ChannelsManager } from "./channels-manager";

function ChannelsCard() {
  const t = useTranslations();
  const canWrite = useCanWrite();
  const channels = usePrivateChannels(true);
  if (channels.data === undefined && channels.error === undefined) {
    return <PrivateChannelsListSkeleton />;
  }
  return (
    <div className="mx-auto w-full max-w-3xl">
      <Card>
        <CardHeader>
          <CardTitle>{t("DashboardPrivateChannels.channels.title")}</CardTitle>
          <CardDescription>{t("DashboardPrivateChannels.channels.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          {channels.data === undefined ? (
            <PrivateChannelsLoadError
              message={channels.error?.message}
              onRetry={() => void channels.mutate()}
            />
          ) : (
            <ChannelsManager channels={channels.data} canWrite={canWrite} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function ChannelsSection() {
  return (
    <PrivateChannelsInstanceGate match="active" skeleton={<PrivateChannelsListSkeleton />}>
      {() => <ChannelsCard />}
    </PrivateChannelsInstanceGate>
  );
}
