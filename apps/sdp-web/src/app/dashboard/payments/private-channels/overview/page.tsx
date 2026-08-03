import { redirect } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getTranslations } from "@/i18n/server";
import { createSdpApiClient } from "@/lib/sdp-api";
import {
  PRIVATE_CHANNELS_INSTANCE_PATH,
  requirePrivateChannelsAccess,
} from "../private-channels-access";
import { PrivateChannelsLoadError } from "../private-channels-load-error";
import {
  loadChannelBalances,
  loadOverview,
  loadWalletVerification,
} from "../private-channels-page.data";
import { InstanceOverviewCard } from "./instance-overview-card";
import { VerifiedWalletsSection } from "./verified-wallets-section";

export default async function PrivateChannelsOverviewPage() {
  await requirePrivateChannelsAccess();

  const t = await getTranslations();

  const client = await createSdpApiClient();
  const [overview, wallets] = await Promise.all([
    loadOverview(client),
    loadWalletVerification(client),
  ]);

  // `ok` with no data is the expected "no active instance" 404 — route to the
  // connect form. A genuine failure keeps the user here and shows the error.
  if (overview.ok && !overview.data) {
    redirect(PRIVATE_CHANNELS_INSTANCE_PATH);
  }

  // Channel balances only exist for verified wallets — unverified reads would 403.
  const channelBalances = wallets.ok
    ? await loadChannelBalances(client, wallets.data.verified)
    : {};

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("DashboardPrivateChannels.overview.title")}</CardTitle>
          <CardDescription>{t("DashboardPrivateChannels.overview.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          {overview.data ? (
            <InstanceOverviewCard
              instance={overview.data.instance}
              overview={overview.data.overview}
            />
          ) : (
            <PrivateChannelsLoadError message={overview.error} />
          )}
        </CardContent>
      </Card>

      <Card id="verified-wallets">
        <CardHeader>
          <CardTitle>{t("DashboardPrivateChannels.verifiedWallets.title")}</CardTitle>
          <CardDescription>
            {t("DashboardPrivateChannels.verifiedWallets.description")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <VerifiedWalletsSection
            verifiedWallets={wallets.data.verified}
            custodyWallets={wallets.data.custody}
            channelBalances={channelBalances}
            loadError={!wallets.ok}
          />
        </CardContent>
      </Card>
    </div>
  );
}
