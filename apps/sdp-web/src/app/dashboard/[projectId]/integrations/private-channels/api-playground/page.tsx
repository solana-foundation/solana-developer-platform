import { redirect } from "next/navigation";
import { projectHref } from "@/lib/dashboard-project-path";
import { PRIVATE_CHANNELS_OVERVIEW_PATH } from "../private-channels-routes";

// The playground merged into the Overview route as its `?tab=` pane so tab
// switches stay shallow. This segment survives only so saved deep links keep
// landing on the playground.
export default async function PrivateChannelsApiPlaygroundPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  redirect(projectHref(projectId, `${PRIVATE_CHANNELS_OVERVIEW_PATH}?tab=playground`));
}
