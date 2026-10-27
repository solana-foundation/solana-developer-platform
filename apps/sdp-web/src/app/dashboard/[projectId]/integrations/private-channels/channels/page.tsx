import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@sdp/ui/card";
import { redirect } from "next/navigation";
import { requirePrivateChannelsAccess } from "@/app/dashboard/[projectId]/integrations/private-channels/private-channels-access";
import { PrivateChannelsLoadError } from "@/app/dashboard/[projectId]/integrations/private-channels/private-channels-load-error";
import {
  loadChannels,
  loadInstance,
} from "@/app/dashboard/[projectId]/integrations/private-channels/private-channels-page.data";
import { PRIVATE_CHANNELS_SETUP_PATH } from "@/app/dashboard/[projectId]/integrations/private-channels/private-channels-routes";
import { getTranslations } from "@/i18n/server";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { createSdpApiClient, requestMemberRole, requestProjectHref } from "@/lib/sdp-api";
import { ChannelsManager } from "./channels-manager";

export default async function PrivateChannelsChannelsPage() {
  await requirePrivateChannelsAccess();

  const t = await getTranslations();

  const client = await createSdpApiClient();
  const instance = await loadInstance(client);
  if (!instance.ok) {
    return <PrivateChannelsLoadError message={instance.error} />;
  }
  if (!instance.data?.isActive) {
    redirect(await requestProjectHref(PRIVATE_CHANNELS_SETUP_PATH));
  }

  const [channels, memberRole] = await Promise.all([loadChannels(client), requestMemberRole()]);
  const { canWrite } = resolveDashboardAccess(memberRole).capabilities;

  return (
    <div className="mx-auto w-full max-w-3xl">
      <Card>
        <CardHeader>
          <CardTitle>{t("DashboardPrivateChannels.channels.title")}</CardTitle>
          <CardDescription>{t("DashboardPrivateChannels.channels.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          {channels.ok ? (
            <ChannelsManager initialChannels={channels.data} canWrite={canWrite} />
          ) : (
            <PrivateChannelsLoadError message={channels.error} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
