import { redirect } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getTranslations } from "@/i18n/server";
import { createSdpApiClient } from "@/lib/sdp-api";
import {
  PRIVATE_CHANNELS_SETUP_PATH,
  requirePrivateChannelsAccess,
} from "../private-channels-access";
import { PrivateChannelsLoadError } from "../private-channels-load-error";
import {
  loadInstance,
  loadSignableWallets,
  loadTokenEligibility,
} from "../private-channels-page.data";
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
    redirect(PRIVATE_CHANNELS_SETUP_PATH);
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
