import { requirePrivateChannelsAccess } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-access";
import { WalletsSection } from "./wallets-section";

export default async function PrivateChannelsWalletsPage() {
  await requirePrivateChannelsAccess();
  return <WalletsSection />;
}
