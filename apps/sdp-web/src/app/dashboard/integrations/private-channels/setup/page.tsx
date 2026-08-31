import { VenetianMaskIcon } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getTranslations } from "@/i18n/server";
import { createSdpApiClient } from "@/lib/sdp-api";
import { requirePrivateChannelsAccess } from "../private-channels-access";
import { loadInstance } from "../private-channels-page.data";
import { PrivateChannelsConnectForm } from "./private-channels-connect-form";

export default async function PrivateChannelsPage() {
  await requirePrivateChannelsAccess();

  const t = await getTranslations();

  const client = await createSdpApiClient();
  const instance = await loadInstance(client);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <header className="flex items-start gap-4">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-fill-strong">
          <VenetianMaskIcon aria-hidden className="size-6 text-secondary" strokeWidth={1.8} />
        </span>
        <div className="space-y-1">
          <p className="text-xs font-medium tracking-wide text-tertiary uppercase">
            {t("DashboardPrivateChannels.instance.setupEyebrow")}
          </p>
          <h1 className="text-xl font-medium tracking-tight text-primary">
            {t("DashboardPrivateChannels.instance.title")}
          </h1>
          <p className="text-sm leading-6 text-secondary">
            {t("DashboardPrivateChannels.instance.description")}
          </p>
        </div>
      </header>
      <Card>
        <CardHeader>
          <CardTitle>{t("DashboardPrivateChannels.instance.setupDetailsTitle")}</CardTitle>
          <CardDescription>
            {t("DashboardPrivateChannels.instance.setupDetailsDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PrivateChannelsConnectForm initialInstance={instance.data} />
        </CardContent>
      </Card>
    </div>
  );
}
