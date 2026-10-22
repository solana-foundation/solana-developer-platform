import type { OrganizationRole } from "@sdp/types/roles";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SelectExistingOrganizationPanel } from "@/components/select-existing-organization-panel";
import { SdpApiResponseError } from "@/lib/sdp-api";

const mocks = vi.hoisted(() => ({
  getSdpAuth: vi.fn(),
  requestMemberRole: vi.fn<() => Promise<OrganizationRole>>(),
}));

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("next/headers", () => import("@/test/next-headers"));
vi.mock("@/lib/sdp-auth", () => ({ getSdpAuth: mocks.getSdpAuth }));
vi.mock("@/lib/sdp-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sdp-api")>()),
  requestMemberRole: mocks.requestMemberRole,
}));

import DashboardLayout from "./layout";

describe("dashboard layout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSdpAuth.mockResolvedValue({ userId: "user_test", orgId: "org_test" });
  });

  it("offers the organization choices under a no-access notice when SDP refuses the session", async () => {
    mocks.requestMemberRole.mockRejectedValue(new SdpApiResponseError(401, "unauthorized"));

    const layout = await DashboardLayout({ children: "dashboard page" });

    expect(layout).toMatchObject({
      type: SelectExistingOrganizationPanel,
      props: { noAccess: true },
    });
  });

  it("propagates any other failure of the member read", async () => {
    mocks.requestMemberRole.mockRejectedValue(new SdpApiResponseError(503, "unavailable"));

    await expect(DashboardLayout({ children: "dashboard page" })).rejects.toThrow(
      "SDP API request failed (503): unavailable"
    );
  });
});
