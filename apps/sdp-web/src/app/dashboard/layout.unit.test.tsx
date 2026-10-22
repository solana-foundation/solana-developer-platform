import { beforeEach, describe, expect, it, vi } from "vitest";
import { SelectExistingOrganizationPanel } from "@/components/select-existing-organization-panel";
import * as sdpApi from "@/lib/sdp-api";

const mocks = vi.hoisted(() => ({ getSdpAuth: vi.fn() }));

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("next/headers", () => import("@/test/next-headers"));
vi.mock("@/lib/sdp-auth", () => ({ getSdpAuth: mocks.getSdpAuth }));

import DashboardLayout from "./layout";

describe("dashboard layout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSdpAuth.mockResolvedValue({ userId: "user_test", orgId: "org_test" });
  });

  it("offers the organization choices under a no-access notice when SDP refuses the session", async () => {
    vi.spyOn(sdpApi, "requestMemberRole").mockRejectedValue(
      new sdpApi.SdpApiResponseError(401, "unauthorized")
    );

    const layout = await DashboardLayout({ children: "dashboard page" });

    expect(layout).toMatchObject({
      type: SelectExistingOrganizationPanel,
      props: { noAccess: true },
    });
  });

  it("propagates any other failure of the member read", async () => {
    vi.spyOn(sdpApi, "requestMemberRole").mockRejectedValue(
      new sdpApi.SdpApiResponseError(503, "unavailable")
    );

    await expect(DashboardLayout({ children: "dashboard page" })).rejects.toThrow(
      "SDP API request failed (503): unavailable"
    );
  });
});
