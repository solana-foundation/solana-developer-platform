import { requirePrivateChannelsAccess } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-access";
import { ChannelDirectory } from "./channel-directory";

export default async function PrivateChannelsOverviewPage() {
  await requirePrivateChannelsAccess();
  return <ChannelDirectory />;
}
