import { requirePrivateChannelsAccess } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-access";
import { PrivateChannelDetail } from "./private-channel-detail";

export default async function PrivateChannelDetailPage({
  params,
}: {
  params: Promise<{ instanceId: string; channelId: string }>;
}) {
  await requirePrivateChannelsAccess();
  const { instanceId, channelId } = await params;
  return <PrivateChannelDetail instanceId={instanceId} channelId={channelId} />;
}
