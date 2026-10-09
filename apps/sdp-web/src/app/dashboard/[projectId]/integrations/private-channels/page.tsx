import { redirect } from "next/navigation";
import { requestProjectHref } from "@/lib/sdp-api";
import { requirePrivateChannelsAccess } from "./private-channels-access";
import { PRIVATE_CHANNELS_OVERVIEW_PATH } from "./private-channels-routes";

/** The integration entry point is the Private Channels home, not a second detail screen. */
export default async function PrivateChannelsPage() {
  await requirePrivateChannelsAccess();
  redirect(await requestProjectHref(PRIVATE_CHANNELS_OVERVIEW_PATH));
}
