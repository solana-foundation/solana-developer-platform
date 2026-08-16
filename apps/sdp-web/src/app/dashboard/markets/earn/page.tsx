import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import {
  fetchActiveApiKeys,
  type PlaygroundApiKeyView,
  resolvePlaygroundApiBaseUrl,
} from "@/app/dashboard/playground-api-data";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { fetchProviderAvailability } from "@/lib/provider-availability";
import { createRequestScopedSdpApiClients } from "@/lib/sdp-api";
import { EarnWorkspace } from "./earn-workspace";

export const dynamic = "force-dynamic";

/**
 * Earn overview — SDP Markets module (V1: Solana Earn). Live data: the
 * workspace reads the shared portfolio program and the synced strategy
 * catalogue through the /api/dashboard/markets/earn BFF proxies (see
 * earn-program-data.ts for the client seam).
 */
export default async function EarnPage() {
  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  // Playground context, resolved server-side like every other module's
  // playground. Best-effort: the API-key read failing must cost the reader the
  // playground's key selector, never the Opportunities and Active tabs beside it.
  let apiKeys: PlaygroundApiKeyView[] = [];
  // Real custody-provider availability, read the same way the custodial deposit
  // wizard reads it. The vault deposit modal reuses `WalletStep`, whose
  // "connect Fireblocks" card is either an invitation or a locked notice — and
  // hard-coding it to locked told entitled organizations something false about
  // their own account.
  let fireblocksEnabled = false;
  try {
    const { projectClient } = await createRequestScopedSdpApiClients();
    if (projectClient) {
      const keysResult = await fetchActiveApiKeys(projectClient.request);
      if (keysResult.ok && keysResult.data) {
        apiKeys = keysResult.data;
      }
      const availability = await fetchProviderAvailability(projectClient.request, orgId).catch(
        () => undefined
      );
      fireblocksEnabled = availability?.enabledCustodyProviders.includes("fireblocks") ?? false;
    }
  } catch {
    // Leaves apiKeys empty, which renders the playground's "needs an API key"
    // notice — the same state a project with no keys sees.
  }

  return (
    <EarnWorkspace
      apiBaseUrl={resolvePlaygroundApiBaseUrl()}
      apiKeys={apiKeys}
      fireblocksEnabled={fireblocksEnabled}
    />
  );
}
