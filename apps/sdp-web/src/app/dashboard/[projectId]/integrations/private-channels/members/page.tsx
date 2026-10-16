import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getTranslations } from "@/i18n/server";
import { createSdpApiClient } from "@/lib/sdp-api";
import { requirePrivateChannelsAccess } from "../private-channels-access";
import { PrivateChannelsLoadError } from "../private-channels-load-error";
import { loadPrincipals } from "../private-channels-page.data";
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
