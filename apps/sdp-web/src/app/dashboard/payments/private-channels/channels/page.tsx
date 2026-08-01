import { redirect } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getTranslations } from "@/i18n/server";
import { createSdpApiClient } from "@/lib/sdp-api";
import {
  PRIVATE_CHANNELS_INSTANCE_PATH,
  requirePrivateChannelsAccess,
} from "../private-channels-access";
import { PrivateChannelsLoadError } from "../private-channels-load-error";
import { loadChannels, loadInstance } from "../private-channels-page.data";
import { ChannelsManager } from "./channels-manager";

export default async function PrivateChannelsChannelsPage() {
  await requirePrivateChannelsAccess();

  const t = await getTranslations();

  const client = await createSdpApiClient();
  // Only redirect on a *known* inactive instance. A failed lookup used to throw
  // out of the page; now it falls through so the load error renders in place.
  const instance = await loadInstance(client);
  if (instance.ok && !instance.data?.isActive) {
    redirect(PRIVATE_CHANNELS_INSTANCE_PATH);
  }

  const channels = await loadChannels(client);

  return (
    <div className="mx-auto w-full max-w-3xl">
      <Card>
        <CardHeader>
          <CardTitle>{t("DashboardPrivateChannels.channels.title")}</CardTitle>
          <CardDescription>{t("DashboardPrivateChannels.channels.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          {channels.ok ? (
            <ChannelsManager initialChannels={channels.data} />
          ) : (
            <PrivateChannelsLoadError message={channels.error} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
