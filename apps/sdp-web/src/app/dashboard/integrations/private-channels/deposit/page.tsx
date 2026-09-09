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
import { DepositForm } from "./deposit-form";

export default async function PrivateChannelsDepositPage() {
  await requirePrivateChannelsAccess();

  const t = await getTranslations();

  const client = await createSdpApiClient();
  const instance = await loadInstance(client);
  if (!instance.ok) {
    return <PrivateChannelsLoadError message={instance.error} />;
  }
  if (!instance.data?.isActive) {
    redirect(PRIVATE_CHANNELS_SETUP_PATH);
  }

  const [wallets, tokenEligibility] = await Promise.all([
    loadSignableWallets(client),
    loadTokenEligibility(client),
  ]);

  return (
    <div className="mx-auto w-full max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle>{t("DashboardPrivateChannels.deposit.title")}</CardTitle>
          <CardDescription>{t("DashboardPrivateChannels.deposit.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          {wallets.ok && tokenEligibility.ok ? (
            <DepositForm
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
