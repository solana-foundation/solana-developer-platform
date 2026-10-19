import { redirect } from "next/navigation";
import { PRIVATE_CHANNELS_OVERVIEW_PATH } from "@/app/dashboard/[projectId]/integrations/private-channels/private-channels-routes";
import { requestProjectHref } from "@/lib/sdp-api";

// The playground merged into the Overview route as its `?tab=` pane so tab
// switches stay shallow. This segment survives only so saved deep links keep
// landing on the playground.
export default async function PrivateChannelsApiPlaygroundPage() {
  redirect(await requestProjectHref(`${PRIVATE_CHANNELS_OVERVIEW_PATH}?tab=playground`));
}
