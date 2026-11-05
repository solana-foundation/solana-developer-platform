import { requirePrivateChannelsAccess } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-access";
import { privateChannelsInstancePath } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-routes";
import { redirectUnlessCanWrite } from "@/lib/require-write-access";
import { CreateChannelScreen } from "./create-channel-screen";

export default async function CreatePrivateChannelPage({
  params,
}: {
  params: Promise<{ instanceId: string }>;
}) {
  await requirePrivateChannelsAccess();
  const { instanceId } = await params;
  await redirectUnlessCanWrite(privateChannelsInstancePath(instanceId));
  return <CreateChannelScreen instanceId={instanceId} />;
}
