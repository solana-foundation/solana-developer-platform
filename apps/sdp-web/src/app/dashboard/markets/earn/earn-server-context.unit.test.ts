import { describe, expect, it, vi } from "vitest";
import type { SdpApiClient } from "@/lib/sdp-api";
import { fetchEarnSdpOrganizationId } from "./earn-server-context";

function organizationClientWith(response: unknown): Pick<SdpApiClient, "fetch"> {
  return {
    fetch: vi.fn().mockResolvedValue(response) as SdpApiClient["fetch"],
  };
}

describe("fetchEarnSdpOrganizationId", () => {
  it("returns the linked SDP organization id, not the Clerk organization id", async () => {
    const client = organizationClientWith({
      linked: true,
      organization: { id: "org_sdp_123" },
    });

    await expect(fetchEarnSdpOrganizationId(client)).resolves.toBe("org_sdp_123");
    expect(client.fetch).toHaveBeenCalledWith("/v1/onboarding/status");
  });

  it("returns null when onboarding has not linked an SDP organization", async () => {
    const client = organizationClientWith({ linked: false, organization: null });

    await expect(fetchEarnSdpOrganizationId(client)).resolves.toBeNull();
  });
});
