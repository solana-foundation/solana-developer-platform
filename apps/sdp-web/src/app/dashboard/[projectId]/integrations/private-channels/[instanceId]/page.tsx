import { notFound } from "next/navigation";
import PrivateChannelsOverviewPage from "@/app/dashboard/[projectId]/integrations/private-channels/overview/page";
import { requirePrivateChannelsAccess } from "@/app/dashboard/[projectId]/integrations/private-channels/private-channels-access";
import { PrivateChannelsLoadError } from "@/app/dashboard/[projectId]/integrations/private-channels/private-channels-load-error";
import { loadInstance } from "@/app/dashboard/[projectId]/integrations/private-channels/private-channels-page.data";
import { createSdpApiClient } from "@/lib/sdp-api";

/** The selected connection is explicit in the URL, even though one is active per project today. */
export default async function PrivateChannelsInstancePage({
  params,
}: {
  params: Promise<{ instanceId: string }>;
}) {
  await requirePrivateChannelsAccess();

  const [{ instanceId }, client] = await Promise.all([params, createSdpApiClient()]);
  const instance = await loadInstance(client);

  if (!instance.ok) return <PrivateChannelsLoadError message={instance.error} />;
  if (!instance.data || instance.data.id !== instanceId) notFound();

  return <PrivateChannelsOverviewPage />;
}
