"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@sdp/ui/card";
import { PrivateChannelsLoadError } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-load-error";
import {
  usePrivateChannelPrincipals,
  usePrivateChannels,
} from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-reads";
import { PrivateChannelsListSkeleton } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-route-skeletons";
import { useCanWrite } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import { MembersTable } from "./members-table";

export function MembersSection() {
  const t = useTranslations();
  const canWrite = useCanWrite();
  const principals = usePrivateChannelPrincipals(true);
  const channels = usePrivateChannels(true);
  const failed = [principals, channels].find(
    (read) => read.data === undefined && read.error !== undefined
  );

  const loaded = principals.data !== undefined && channels.data !== undefined;
  if (!loaded && failed === undefined) return <PrivateChannelsListSkeleton maxWidth="max-w-5xl" />;
  return (
    <div className="mx-auto w-full max-w-5xl">
      <Card>
        <CardHeader>
          <CardTitle>{t("DashboardPrivateChannels.members.title")}</CardTitle>
          <CardDescription>{t("DashboardPrivateChannels.members.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          {principals.data !== undefined && channels.data !== undefined ? (
            <MembersTable
              principals={principals.data}
              channels={channels.data}
              canWrite={canWrite}
            />
          ) : (
            <PrivateChannelsLoadError
              message={failed?.error?.message}
              onRetry={() => {
                if (principals.error !== undefined) void principals.mutate();
                if (channels.error !== undefined) void channels.mutate();
              }}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
