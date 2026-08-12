import { cookies } from "next/headers";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getTranslations } from "@/i18n/server";
import { PROJECT_COOKIE_NAME } from "@/lib/project-cookie";
import { createSdpApiClient } from "@/lib/sdp-api";
import { requirePrivateChannelsAccess } from "../private-channels-access";
import { PrivateChannelsLoadError } from "../private-channels-load-error";
import { loadMembers } from "../private-channels-page.data";
import { MembersTable } from "./members-table";

export default async function PrivateChannelsMembersPage() {
  await requirePrivateChannelsAccess();

  const t = await getTranslations();

  const [client, cookieStore] = await Promise.all([createSdpApiClient(), cookies()]);
  const projectId = cookieStore.get(PROJECT_COOKIE_NAME)?.value;
  const members = await loadMembers(client, projectId);

  return (
    <div className="mx-auto w-full max-w-5xl">
      <Card>
        <CardHeader>
          <CardTitle>{t("DashboardPrivateChannels.members.title")}</CardTitle>
          <CardDescription>{t("DashboardPrivateChannels.members.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          {members.ok ? (
            <MembersTable
              members={members.data.users}
              channels={members.data.channels}
              eligibleProjectMembers={members.data.projectMembers}
            />
          ) : (
            <PrivateChannelsLoadError message={members.error} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
