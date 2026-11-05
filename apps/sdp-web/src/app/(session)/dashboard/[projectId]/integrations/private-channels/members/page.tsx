import { requirePrivateChannelsAccess } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-access";
import { MembersSection } from "./members-section";

export default async function PrivateChannelsMembersPage() {
  await requirePrivateChannelsAccess();
  return <MembersSection />;
}
