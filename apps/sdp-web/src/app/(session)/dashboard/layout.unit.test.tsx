import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthPageShell } from "@/components/auth-page-shell";
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
    mocks.getSdpAuth.mockResolvedValue({ orgId: "org_test" });
  });

  it("offers the organization choices under a no-access notice when SDP refuses the session", async () => {
    vi.spyOn(sdpApi, "requestMemberRole").mockRejectedValue(
      new sdpApi.SdpApiResponseError(401, "unauthorized")
    );

    const layout = await DashboardLayout({ children: "dashboard page" });

    expect(layout).toMatchObject({
      type: AuthPageShell,
      props: {
        action: null,
        children: {
          type: SelectExistingOrganizationPanel,
          props: { refusal: "no-access" },
        },
      },
    });
  });

  it("explains an expired invitation when SDP refuses the session for one", async () => {
    vi.spyOn(sdpApi, "requestMemberRole").mockRejectedValue(
      new sdpApi.SdpApiResponseError(
        401,
        JSON.stringify({
          error: {
            code: "UNAUTHORIZED",
            message: "Invitation to this organization has expired",
            details: { reason: "invitation_expired" },
          },
        })
      )
    );

    const layout = await DashboardLayout({ children: "dashboard page" });

    expect(layout).toMatchObject({
      props: {
        children: {
          type: SelectExistingOrganizationPanel,
          props: { refusal: "invitation-expired" },
        },
      },
    });
  });

  it("says the organization is suspended when SDP refuses the session for that", async () => {
    vi.spyOn(sdpApi, "requestMemberRole").mockRejectedValue(
      new sdpApi.SdpApiResponseError(
        403,
        JSON.stringify({
          error: {
            code: "FORBIDDEN",
            message: "This organization is suspended. Contact SDP support to restore access.",
            details: { reason: "organization_suspended" },
          },
        })
      )
    );

    const layout = await DashboardLayout({ children: "dashboard page" });

    expect(layout).toMatchObject({
      props: {
        children: {
          type: SelectExistingOrganizationPanel,
          props: { refusal: "organization-suspended" },
        },
      },
    });
  });

  it("propagates any other 403 of the member read", async () => {
    vi.spyOn(sdpApi, "requestMemberRole").mockRejectedValue(
      new sdpApi.SdpApiResponseError(403, "forbidden")
    );

    await expect(DashboardLayout({ children: "dashboard page" })).rejects.toThrow(
      "SDP API request failed (403): forbidden"
    );
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
