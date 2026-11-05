import { requirePrivateChannelsAccess } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-access";
import { PRIVATE_CHANNELS_OVERVIEW_PATH } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-routes";
import { redirectUnlessCanWrite } from "@/lib/require-write-access";
import { DepositSection } from "./deposit-section";

export default async function PrivateChannelsDepositPage() {
  await requirePrivateChannelsAccess();
  await redirectUnlessCanWrite(PRIVATE_CHANNELS_OVERVIEW_PATH);
  return <DepositSection />;
}
