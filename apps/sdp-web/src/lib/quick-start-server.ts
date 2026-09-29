import type { ListApiKeysResponse } from "@sdp/types";
import { cache } from "react";
import type { OnboardingStatusResponse } from "@/app/dashboard/onboarding-status";
import type { QuickStartStatus } from "./dashboard-quick-start";
import { PROJECT_HEADER_NAME } from "./project-cookie";
import { createOrgSdpApiClient, listSdpProjects } from "./sdp-api";

function latestTimestamp(values: readonly (string | null)[]): string | null {
  let latest: string | null = null;
  for (const value of values) {
    if (value && (latest === null || Date.parse(value) > Date.parse(latest))) latest = value;
  }
  return latest;
}

/**
 * The setup signals the quick start is built from, or null when the viewer cannot manage setup
 * or the status is unknown. Unknown is not new: a status failure must not flash a guide.
 */
export const loadQuickStartStatus = cache(async (): Promise<QuickStartStatus | null> => {
  try {
    const client = await createOrgSdpApiClient();
    const signal = AbortSignal.timeout(10_000);
    const status = await client.fetch<OnboardingStatusResponse>("/v1/onboarding/status", {
      signal,
    });
    if (!status.linked || !status.setup?.canManage) return null;

    // A first call can come from a key in any project, not only the default sandbox.
    const projects = await listSdpProjects();
    if (projects.length === 0) return null;
    const keys = await Promise.allSettled(
      projects.map((project) =>
        client.fetch<ListApiKeysResponse>("/v1/api-keys", {
          headers: { [PROJECT_HEADER_NAME]: project.id },
          signal,
        })
      )
    );
    const apiKeys = keys.flatMap((result) =>
      result.status === "fulfilled" ? result.value.apiKeys : []
    );
    if (apiKeys.length === 0 && keys.some((result) => result.status === "rejected")) return null;

    return {
      rpcProvider: status.setup.rpcProvider,
      custodyProvider: status.setup.custodyProvider,
      apiKeyCount: apiKeys.length,
      lastCallAt: latestTimestamp(apiKeys.map((key) => key.lastUsedAt)),
    };
  } catch {
    return null;
  }
});
