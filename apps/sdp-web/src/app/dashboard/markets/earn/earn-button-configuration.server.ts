import "server-only";

import type { EarnButtonConfiguration, EarnButtonConfigurationResponse } from "@sdp/types";
import { createSdpApiClient, SdpApiResponseError } from "@/lib/sdp-api";

export type EarnButtonConfigurationLoad =
  | { kind: "ready"; configuration: EarnButtonConfiguration | null }
  | { kind: "error" };

export async function loadEarnButtonConfiguration(): Promise<EarnButtonConfigurationLoad> {
  try {
    const client = await createSdpApiClient();
    const response = await client.fetch<EarnButtonConfigurationResponse>(
      "/v1/earn/button-configurations/current"
    );
    return { kind: "ready", configuration: response.configuration };
  } catch (error) {
    if (error instanceof SdpApiResponseError && error.status === 404) {
      return { kind: "ready", configuration: null };
    }
    console.error("Failed to load the Earn button configuration", error);
    return { kind: "error" };
  }
}
