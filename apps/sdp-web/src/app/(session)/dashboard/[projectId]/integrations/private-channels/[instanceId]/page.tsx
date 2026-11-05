import { ChannelDirectory } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/overview/channel-directory";
import { requirePrivateChannelsAccess } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-access";

/** The selected connection is explicit in the URL, even though one is active per project today. */
export default async function PrivateChannelsInstancePage({
  params,
}: {
  params: Promise<{ instanceId: string }>;
}) {
  await requirePrivateChannelsAccess();
  const { instanceId } = await params;
  return <ChannelDirectory instanceId={instanceId} />;
}
