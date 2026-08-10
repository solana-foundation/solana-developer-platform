import {
  fetchActiveApiKeys,
  resolvePlaygroundApiBaseUrl,
} from "@/app/dashboard/playground-api-data";
import { createSdpApiClient } from "@/lib/sdp-api";
import { requirePrivateChannelsAccess } from "../private-channels-access";
import { PrivateChannelsPlayground } from "./private-channels-playground";

export const dynamic = "force-dynamic";

export default async function PrivateChannelsApiPlaygroundPage() {
  await requirePrivateChannelsAccess();

  const client = await createSdpApiClient();
  const apiKeysResult = await fetchActiveApiKeys(client.request);

  // The Private Channels layout gives direct children a definite flex height below
  // the tab strip. Take that remaining space so the playground can own its internal
  // request/response scrolling instead of growing beyond the viewport.
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <PrivateChannelsPlayground
        apiBaseUrl={resolvePlaygroundApiBaseUrl()}
        apiKeys={apiKeysResult.data ?? []}
      />
    </div>
  );
}
