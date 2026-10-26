import { CUSTODY_PROVIDERS } from "@sdp/types/custody";
import { cache } from "react";
import { z } from "zod";
import type { QuickStartStatus } from "./dashboard-quick-start";
import { PROJECT_HEADER_NAME } from "./project-cookie";
import { createOrgSdpApiClient, listSdpProjects } from "./sdp-api";

// Only the fields the guide reads: the rest of each response is not its business.
const onboardingStatusSchema = z.object({
  linked: z.boolean(),
  setup: z
    .object({
      canManage: z.boolean(),
      custodyProviders: z.array(z.enum(CUSTODY_PROVIDERS)),
    })
    .nullish(),
});
const apiKeysSchema = z.object({
  apiKeys: z.array(z.object({ lastUsedAt: z.string().nullable() })),
});

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
    const status = onboardingStatusSchema.parse(
      await client.fetch<unknown>("/v1/onboarding/status", { signal })
    );
    if (!status.linked || !status.setup?.canManage) return null;

    // A first call can come from a key in any project, not only the default sandbox.
    const projects = await listSdpProjects();
    if (projects.length === 0) return null;
    const keys = await Promise.allSettled(
      projects.map((project) =>
        client
          .fetch<unknown>("/v1/api-keys", {
            headers: { [PROJECT_HEADER_NAME]: project.id },
            signal,
          })
          .then((body) => apiKeysSchema.parse(body))
      )
    );
    const apiKeys = keys.flatMap((result) =>
      result.status === "fulfilled" ? result.value.apiKeys : []
    );
    if (apiKeys.length === 0 && keys.some((result) => result.status === "rejected")) return null;

    return {
      custodyProvider: status.setup.custodyProviders[0] ?? null,
      apiKeyCount: apiKeys.length,
      lastCallAt: latestTimestamp(apiKeys.map((key) => key.lastUsedAt)),
    };
  } catch {
    return null;
  }
});
