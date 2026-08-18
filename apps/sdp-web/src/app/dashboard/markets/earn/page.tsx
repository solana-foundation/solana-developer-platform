import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import {
  fetchActiveApiKeys,
  type PlaygroundApiKeyView,
  resolvePlaygroundApiBaseUrl,
} from "@/app/dashboard/playground-api-data";
import { getAuthEntryPath } from "@/lib/auth-entry";
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
  try {
    const { projectClient } = await createRequestScopedSdpApiClients();
    if (projectClient) {
      const keysResult = await fetchActiveApiKeys(projectClient.request);
      if (keysResult.ok && keysResult.data) {
        apiKeys = keysResult.data;
      }
    }
  } catch {
    // Leaves apiKeys empty, which renders the playground's "needs an API key"
    // notice — the same state a project with no keys sees.
  }

  return <EarnWorkspace apiBaseUrl={resolvePlaygroundApiBaseUrl()} apiKeys={apiKeys} />;
}
