import { redirect } from "next/navigation";
import { createSdpApiClient } from "@/lib/sdp-api";
import {
  PRIVATE_CHANNELS_INSTANCE_PATH,
  PRIVATE_CHANNELS_OVERVIEW_PATH,
  requirePrivateChannelsAccess,
} from "./private-channels-access";
import { loadInstance } from "./private-channels-page.data";

// Overview is the landing when connected; Instance is the landing otherwise —
// which is also the safe default for a transient lookup failure.
export default async function PrivateChannelsPage() {
  await requirePrivateChannelsAccess();

  const client = await createSdpApiClient();
  const instance = await loadInstance(client);

  redirect(
    instance.data?.isActive ? PRIVATE_CHANNELS_OVERVIEW_PATH : PRIVATE_CHANNELS_INSTANCE_PATH
  );
}
