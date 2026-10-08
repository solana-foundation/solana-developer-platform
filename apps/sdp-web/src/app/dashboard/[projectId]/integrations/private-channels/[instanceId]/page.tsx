import { notFound } from "next/navigation";
import { createSdpApiClient } from "@/lib/sdp-api";
import PrivateChannelsOverviewPage from "../overview/page";
import { requirePrivateChannelsAccess } from "../private-channels-access";
import { PrivateChannelsLoadError } from "../private-channels-load-error";
import { loadInstance } from "../private-channels-page.data";

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
