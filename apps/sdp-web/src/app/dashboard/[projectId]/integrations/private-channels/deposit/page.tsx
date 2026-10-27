import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@sdp/ui/card";
import { redirect } from "next/navigation";
import { requirePrivateChannelsAccess } from "@/app/dashboard/[projectId]/integrations/private-channels/private-channels-access";
import { PrivateChannelsLoadError } from "@/app/dashboard/[projectId]/integrations/private-channels/private-channels-load-error";
import {
  loadInstance,
  loadSignableWallets,
  loadTokenEligibility,
} from "@/app/dashboard/[projectId]/integrations/private-channels/private-channels-page.data";
import {
  PRIVATE_CHANNELS_OVERVIEW_PATH,
  PRIVATE_CHANNELS_SETUP_PATH,
} from "@/app/dashboard/[projectId]/integrations/private-channels/private-channels-routes";
import { getTranslations } from "@/i18n/server";
import { redirectUnlessCanWrite } from "@/lib/require-write-access";
import { createSdpApiClient, requestProjectHref } from "@/lib/sdp-api";
import { DepositForm } from "./deposit-form";

export default async function PrivateChannelsDepositPage() {
  await requirePrivateChannelsAccess();
  await redirectUnlessCanWrite(PRIVATE_CHANNELS_OVERVIEW_PATH);

  const t = await getTranslations();

  const client = await createSdpApiClient();
  const instance = await loadInstance(client);
  if (!instance.ok) {
    return <PrivateChannelsLoadError message={instance.error} />;
  }
  if (!instance.data?.isActive) {
    redirect(await requestProjectHref(PRIVATE_CHANNELS_SETUP_PATH));
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
