import { notFound } from "next/navigation";
import { requirePrivateChannelsAccess } from "@/app/dashboard/[projectId]/integrations/private-channels/private-channels-access";
import { PrivateChannelsLoadError } from "@/app/dashboard/[projectId]/integrations/private-channels/private-channels-load-error";
import { loadInstance } from "@/app/dashboard/[projectId]/integrations/private-channels/private-channels-page.data";
import { privateChannelsInstancePath } from "@/app/dashboard/[projectId]/integrations/private-channels/private-channels-routes";
import { redirectUnlessCanWrite } from "@/lib/require-write-access";
import { createSdpApiClient } from "@/lib/sdp-api";
import { CreateChannelScreen } from "./create-channel-screen";

export default async function CreatePrivateChannelPage({
  params,
}: {
  params: Promise<{ instanceId: string }>;
}) {
  await requirePrivateChannelsAccess();

  const [{ instanceId }, client] = await Promise.all([params, createSdpApiClient()]);
  await redirectUnlessCanWrite(privateChannelsInstancePath(instanceId));
  const instance = await loadInstance(client);

  if (!instance.ok) return <PrivateChannelsLoadError message={instance.error} />;
  if (!instance.data?.isActive || instance.data.id !== instanceId) notFound();

  return <CreateChannelScreen instanceId={instanceId} instance={instance.data} />;
}
