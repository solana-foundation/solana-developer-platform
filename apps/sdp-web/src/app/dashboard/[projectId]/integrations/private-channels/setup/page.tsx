import { redirect } from "next/navigation";
import { requirePrivateChannelsAccess } from "@/app/dashboard/[projectId]/integrations/private-channels/private-channels-access";
import { loadInstance } from "@/app/dashboard/[projectId]/integrations/private-channels/private-channels-page.data";
import { privateChannelsSetupPath } from "@/app/dashboard/[projectId]/integrations/private-channels/private-channels-routes";
import { createSdpApiClient, requestProjectHref } from "@/lib/sdp-api";
import { PrivateChannelsSetupScreen } from "./private-channels-setup-screen";

/** Entry point before a connection exists; active connections use their scoped URL. */
export default async function PrivateChannelsSetupPage() {
  await requirePrivateChannelsAccess();

  const client = await createSdpApiClient();
  const instance = await loadInstance(client);

  if (instance.data?.isActive)
    redirect(await requestProjectHref(privateChannelsSetupPath(instance.data.id)));

  return <PrivateChannelsSetupScreen instance={instance.data} />;
}
