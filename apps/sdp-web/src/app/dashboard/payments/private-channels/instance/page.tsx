import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getTranslations } from "@/i18n/server";
import { createSdpApiClient } from "@/lib/sdp-api";
import { requirePrivateChannelsAccess } from "../private-channels-access";
import { PrivateChannelsLoadError } from "../private-channels-load-error";
import { loadInstance } from "../private-channels-page.data";
import { PrivateChannelsConnectForm } from "./private-channels-connect-form";

export default async function PrivateChannelsPage() {
  await requirePrivateChannelsAccess();

  const t = await getTranslations();

  const client = await createSdpApiClient();
  const instance = await loadInstance(client);

  return (
    <div className="mx-auto w-full max-w-3xl">
      <Card>
        <CardHeader>
          <CardTitle>{t("DashboardPrivateChannels.instance.title")}</CardTitle>
          <CardDescription>{t("DashboardPrivateChannels.instance.description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* The form is still usable on a failed lookup (it falls back to the
              sandbox defaults), so surface the error above it rather than
              replacing it — otherwise a transient 500 blocks reconnecting. */}
          {instance.ok ? null : <PrivateChannelsLoadError message={instance.error} />}
          <PrivateChannelsConnectForm initialInstance={instance.data} />
        </CardContent>
      </Card>
    </div>
  );
}
