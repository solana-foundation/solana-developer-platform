import { redirect } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getTranslations } from "@/i18n/server";
import {
  fetchPrivateChannelPrincipals,
  fetchPrivateChannels,
  fetchPrivateChannelTokenEligibility,
  fetchSignableCustodyWallets,
  fetchVerifiedWallets,
} from "@/lib/private-channels";
import { createSdpApiClient, extractSdpApiErrorMessage } from "@/lib/sdp-api";
import {
  PRIVATE_CHANNELS_SETUP_PATH,
  requirePrivateChannelsAccess,
} from "../private-channels-access";
import { PrivateChannelsLoadError } from "../private-channels-load-error";
import { loadInstance } from "../private-channels-page.data";
import { TransferForm } from "./transfer-form";
import {
  createTransferScopeKey,
  intersectEligibleTransferChannels,
  intersectVerifiedSourceWallets,
} from "./transfer-page-data";

export default async function PrivateChannelsTransferPage() {
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

  let loadError: string | undefined;
  let channels = intersectEligibleTransferChannels([], []);
  let sourceWallets = intersectVerifiedSourceWallets([], []);
  let tokens = [] as Awaited<ReturnType<typeof fetchPrivateChannelTokenEligibility>>;
  try {
    const [principals, activeChannels, signableWallets, verifiedWallets, tokenEligibility] =
      await Promise.all([
        fetchPrivateChannelPrincipals(client),
        fetchPrivateChannels(client),
        fetchSignableCustodyWallets(client),
        fetchVerifiedWallets(client),
        fetchPrivateChannelTokenEligibility(client),
      ]);
    const defaultPrincipal = principals.find((principal) => principal.isDefault);
    channels = intersectEligibleTransferChannels(defaultPrincipal?.channels ?? [], activeChannels);
    sourceWallets = intersectVerifiedSourceWallets(signableWallets, verifiedWallets);
    tokens = tokenEligibility.filter((token) => token.enabled);
  } catch (error) {
    loadError = extractSdpApiErrorMessage(error);
  }

  const scopeKey = createTransferScopeKey(
    instance.data.organizationId,
    instance.data.projectId,
    instance.data.id
  );

  return (
    <div className="mx-auto w-full max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle>{t("DashboardPrivateChannels.transfer.title")}</CardTitle>
          <CardDescription>{t("DashboardPrivateChannels.transfer.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          {loadError ? (
            <PrivateChannelsLoadError message={loadError} />
          ) : (
            <TransferForm
              channels={channels}
              scopeKey={scopeKey}
              sourceWallets={sourceWallets}
              tokens={tokens}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
