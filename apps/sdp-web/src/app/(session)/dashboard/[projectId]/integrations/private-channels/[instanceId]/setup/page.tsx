import { requirePrivateChannelsAccess } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-access";
import { privateChannelsInstancePath } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-routes";
import { PrivateChannelsInstanceSetup } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/setup/private-channels-setup-entry";
import { redirectUnlessCanWrite } from "@/lib/require-write-access";

export default async function PrivateChannelsInstanceSetupPage({
  params,
}: {
  params: Promise<{ instanceId: string }>;
}) {
  await requirePrivateChannelsAccess();
  const { instanceId } = await params;
  await redirectUnlessCanWrite(privateChannelsInstancePath(instanceId));
  return <PrivateChannelsInstanceSetup instanceId={instanceId} />;
}
