import { redirect } from "next/navigation";
import { projectHref } from "@/lib/dashboard-project-path";
import { createProjectBoundSdpApiClient } from "@/lib/sdp-api";
import { requirePrivateChannelsAccess } from "../private-channels-access";
import { loadInstance } from "../private-channels-page.data";
import { privateChannelsSetupPath } from "../private-channels-routes";
import { PrivateChannelsSetupScreen } from "./private-channels-setup-screen";

/** Entry point before a connection exists; active connections use their scoped URL. */
export default async function PrivateChannelsSetupPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  await requirePrivateChannelsAccess();
  const { projectId } = await params;

  const client = await createProjectBoundSdpApiClient(projectId);
  const instance = await loadInstance(client);

  if (instance.data?.isActive)
    redirect(projectHref(projectId, privateChannelsSetupPath(instance.data.id)));

  return <PrivateChannelsSetupScreen instance={instance.data} />;
}
