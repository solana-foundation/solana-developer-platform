import type { CustodyWalletsResponse, ListApiKeysResponse } from "@sdp/types";
import { cache } from "react";
import type { OnboardingStatusResponse } from "@/app/dashboard/onboarding-status";
import type { QuickStartStep } from "./dashboard-quick-start";
import { PROJECT_HEADER_NAME } from "./project-cookie";
import { createOrgSdpApiClient, listSdpProjects } from "./sdp-api";

export const loadQuickStartStep = cache(async (): Promise<QuickStartStep | null> => {
  try {
    const client = await createOrgSdpApiClient();
    const signal = AbortSignal.timeout(10_000);
    const status = await client.fetch<OnboardingStatusResponse>("/v1/onboarding/status", {
      signal,
    });
    if (!status.linked || !status.setup?.canManage) return null;
    if (status.setup.status === "complete" || status.setup.custodyProvider) return "done";

    // The default sandbox is not the only place an organization can have a wallet.
    const projects = await listSdpProjects();
    if (projects.length === 0) return null;
    const wallets = await Promise.allSettled(
      projects.map((project) =>
        client.fetch<CustodyWalletsResponse>(
          "/v1/wallets?includeAllProviders=true&includeBalances=false&view=summary",
          { headers: { [PROJECT_HEADER_NAME]: project.id }, signal }
        )
      )
    );
    if (wallets.some((result) => result.status === "fulfilled" && result.value.wallets.length > 0))
      return "done";
    if (wallets.some((result) => result.status === "rejected")) return null;
    const keys = await Promise.allSettled(
      projects.map((project) =>
        client.fetch<ListApiKeysResponse>("/v1/api-keys", {
          headers: { [PROJECT_HEADER_NAME]: project.id },
          signal,
        })
      )
    );
    // Key creation is already complete, even without a wallet binding or browser history.
    if (keys.some((result) => result.status === "fulfilled" && result.value.apiKeys.length > 0))
      return "wallet";
    if (keys.some((result) => result.status === "rejected")) return null;
    return "api-key";
  } catch {
    // Unknown is not new: don't flash an onboarding modal on a status failure.
    return null;
  }
});
