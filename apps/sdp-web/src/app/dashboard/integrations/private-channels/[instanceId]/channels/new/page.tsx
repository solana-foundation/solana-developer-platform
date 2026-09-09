import { notFound } from "next/navigation";
import { createSdpApiClient } from "@/lib/sdp-api";
import { requirePrivateChannelsAccess } from "../../../private-channels-access";
import { PrivateChannelsLoadError } from "../../../private-channels-load-error";
import { loadInstance } from "../../../private-channels-page.data";
import { CreateChannelScreen } from "./create-channel-screen";

export default async function CreatePrivateChannelPage({
  params,
}: {
  params: Promise<{ instanceId: string }>;
}) {
  await requirePrivateChannelsAccess();

  const [{ instanceId }, client] = await Promise.all([params, createSdpApiClient()]);
  const instance = await loadInstance(client);

  if (!instance.ok) return <PrivateChannelsLoadError message={instance.error} />;
  if (!instance.data?.isActive || instance.data.id !== instanceId) notFound();

  return <CreateChannelScreen instanceId={instanceId} instance={instance.data} />;
}
