import { requirePrivateChannelsAccess } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-access";
import { ChannelsSection } from "./channels-section";

export default async function PrivateChannelsChannelsPage() {
  await requirePrivateChannelsAccess();
  return <ChannelsSection />;
}
