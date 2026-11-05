import { requirePrivateChannelsAccess } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-access";
import { PRIVATE_CHANNELS_OVERVIEW_PATH } from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/private-channels-routes";
import { redirectUnlessCanWrite } from "@/lib/require-write-access";
import { PrivateChannelsSetupEntry } from "./private-channels-setup-entry";

/** Entry point before a connection exists; active connections use their scoped URL. */
export default async function PrivateChannelsSetupPage() {
  await requirePrivateChannelsAccess();
  await redirectUnlessCanWrite(PRIVATE_CHANNELS_OVERVIEW_PATH);
  return <PrivateChannelsSetupEntry />;
}
