import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@sdp/ui/card";
import { redirect } from "next/navigation";
import { requirePrivateChannelsAccess } from "@/app/dashboard/[projectId]/integrations/private-channels/private-channels-access";
import { PrivateChannelsLoadError } from "@/app/dashboard/[projectId]/integrations/private-channels/private-channels-load-error";
import {
  loadInstance,
  loadSignableWallets,
  loadTokenEligibility,
} from "@/app/dashboard/[projectId]/integrations/private-channels/private-channels-page.data";
import { PRIVATE_CHANNELS_SETUP_PATH } from "@/app/dashboard/[projectId]/integrations/private-channels/private-channels-routes";
import { getTranslations } from "@/i18n/server";
import { createSdpApiClient, requestProjectHref } from "@/lib/sdp-api";
import { WithdrawForm } from "./withdraw-form";

export default async function PrivateChannelsWithdrawPage() {
  await requirePrivateChannelsAccess();

  const [t, client] = await Promise.all([getTranslations(), createSdpApiClient()]);
  const [instance, wallets, tokenEligibility] = await Promise.all([
    loadInstance(client),
    loadSignableWallets(client),
    loadTokenEligibility(client),
  ]);
  if (!instance.ok) {
    return <PrivateChannelsLoadError message={instance.error} />;
  }
  if (!instance.data?.isActive) {
    redirect(await requestProjectHref(PRIVATE_CHANNELS_SETUP_PATH));
  }

  return (
    <div className="mx-auto w-full max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle>{t("DashboardPrivateChannels.withdraw.title")}</CardTitle>
          <CardDescription>{t("DashboardPrivateChannels.withdraw.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          {wallets.ok && tokenEligibility.ok ? (
            <WithdrawForm
              tokens={tokenEligibility.data.filter((token) => token.enabled)}
              wallets={wallets.data}
            />
          ) : (
            <PrivateChannelsLoadError message={wallets.error ?? tokenEligibility.error} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
