import { inferCluster, privateChannelTokens } from "@sdp/types";
import { redirect } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getTranslations } from "@/i18n/server";
import { createSdpApiClient } from "@/lib/sdp-api";
import {
  PRIVATE_CHANNELS_INSTANCE_PATH,
  requirePrivateChannelsAccess,
} from "../private-channels-access";
import { PrivateChannelsLoadError } from "../private-channels-load-error";
import { loadInstance, loadSignableWallets } from "../private-channels-page.data";
import { WithdrawForm } from "./withdraw-form";

export default async function PrivateChannelsWithdrawPage() {
  await requirePrivateChannelsAccess();

  const t = await getTranslations();

  const client = await createSdpApiClient();
  const instance = await loadInstance(client);
  if (!instance.ok) {
    return <PrivateChannelsLoadError message={instance.error} />;
  }
  if (!instance.data?.isActive) {
    redirect(PRIVATE_CHANNELS_INSTANCE_PATH);
  }

  const wallets = await loadSignableWallets(client);

  const tokens = privateChannelTokens(inferCluster(instance.data.chainRpcUrl));

  return (
    <div className="mx-auto w-full max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle>{t("DashboardPrivateChannels.withdraw.title")}</CardTitle>
          <CardDescription>{t("DashboardPrivateChannels.withdraw.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          {wallets.ok ? (
            <WithdrawForm tokens={tokens} wallets={wallets.data} />
          ) : (
            <PrivateChannelsLoadError message={wallets.error} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
