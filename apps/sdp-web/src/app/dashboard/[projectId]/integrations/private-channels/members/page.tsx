import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@sdp/ui/card";
import { requirePrivateChannelsAccess } from "@/app/dashboard/[projectId]/integrations/private-channels/private-channels-access";
import { PrivateChannelsLoadError } from "@/app/dashboard/[projectId]/integrations/private-channels/private-channels-load-error";
import { loadPrincipals } from "@/app/dashboard/[projectId]/integrations/private-channels/private-channels-page.data";
import { getTranslations } from "@/i18n/server";
import { createSdpApiClient } from "@/lib/sdp-api";
import { MembersTable } from "./members-table";

export default async function PrivateChannelsMembersPage() {
  await requirePrivateChannelsAccess();

  const [t, client] = await Promise.all([getTranslations(), createSdpApiClient()]);
  const principals = await loadPrincipals(client);

  return (
    <div className="mx-auto w-full max-w-5xl">
      <Card>
        <CardHeader>
          <CardTitle>{t("DashboardPrivateChannels.members.title")}</CardTitle>
          <CardDescription>{t("DashboardPrivateChannels.members.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          {principals.ok ? (
            <MembersTable
              principals={principals.data.principals}
              channels={principals.data.channels}
            />
          ) : (
            <PrivateChannelsLoadError message={principals.error} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
