import { fetchActiveApiKeys, resolvePlaygroundApiBaseUrl } from "@/app/dashboard/playground-api-data";
import { createSdpApiClient } from "@/lib/sdp-api";
import { requirePrivateChannelsAccess } from "../private-channels-access";
import { PrivateChannelsPlayground } from "./private-channels-playground";

export const dynamic = "force-dynamic";

export default async function PrivateChannelsApiPlaygroundPage() {
  await requirePrivateChannelsAccess();

  const client = await createSdpApiClient();
  const apiKeysResult = await fetchActiveApiKeys(client.request);

  // The Private Channels layout renders `<> tabs + {children} </>` inside the
  // dashboard shell's `flex flex-col min-h-0 flex-1` region. To fill the
  // remaining vertical space (below the tab bar), this page must be a flex
  // child that takes flex-1 — h-full would collapse to 0 here because the
  // parent has no fixed height.
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <PrivateChannelsPlayground
        apiBaseUrl={resolvePlaygroundApiBaseUrl()}
        apiKeys={apiKeysResult.data ?? []}
      />
    </div>
  );
}
