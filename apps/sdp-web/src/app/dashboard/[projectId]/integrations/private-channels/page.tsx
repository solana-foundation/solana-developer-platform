import { redirect } from "next/navigation";
import { projectHref } from "@/lib/dashboard-project-path";
import { requirePrivateChannelsAccess } from "./private-channels-access";
import { PRIVATE_CHANNELS_OVERVIEW_PATH } from "./private-channels-routes";

/** The integration entry point is the Private Channels home, not a second detail screen. */
export default async function PrivateChannelsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  await requirePrivateChannelsAccess();
  const { projectId } = await params;
  redirect(projectHref(projectId, PRIVATE_CHANNELS_OVERVIEW_PATH));
}
