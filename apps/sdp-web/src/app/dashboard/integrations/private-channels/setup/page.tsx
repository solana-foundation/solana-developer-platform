import { redirect } from "next/navigation";
import { createSdpApiClient } from "@/lib/sdp-api";
import { requirePrivateChannelsAccess } from "../private-channels-access";
import { loadInstance } from "../private-channels-page.data";
import { privateChannelsSetupPath } from "../private-channels-routes";
import { PrivateChannelsSetupScreen } from "./private-channels-setup-screen";

/** Entry point before a connection exists; active connections use their scoped URL. */
export default async function PrivateChannelsSetupPage() {
  await requirePrivateChannelsAccess();

  const client = await createSdpApiClient();
  const instance = await loadInstance(client);

  if (instance.data?.isActive) redirect(privateChannelsSetupPath(instance.data.id));

  return <PrivateChannelsSetupScreen instance={instance.data} />;
}
