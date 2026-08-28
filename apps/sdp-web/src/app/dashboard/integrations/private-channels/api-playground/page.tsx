import { redirect } from "next/navigation";
import { PRIVATE_CHANNELS_OVERVIEW_PATH } from "../private-channels-routes";

// The playground merged into the Overview route as its `?tab=` pane so tab
// switches stay shallow. This segment survives only so saved deep links keep
// landing on the playground.
export default function PrivateChannelsApiPlaygroundPage() {
  redirect(`${PRIVATE_CHANNELS_OVERVIEW_PATH}?tab=playground`);
}
