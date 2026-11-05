import { NextResponse } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as sdpApi from "@/lib/sdp-api";
import { GET as memberApiKeys } from "./members/[memberId]/api-keys/route";
import { PATCH as changeMemberRole, DELETE as removeMember } from "./members/[memberId]/route";
import { DELETE as revokeInvitation } from "./members/invitations/[invitationId]/route";
import { POST as inviteMember } from "./members/invite/route";
import { DELETE as leaveOrganization } from "./members/me/route";
import { POST as notifyMainnetAccess } from "./organizations/[organizationId]/mainnet-access/notify/route";
import { POST as requestMainnetAccess } from "./organizations/[organizationId]/mainnet-access/route";
import { PATCH as updateOrganization } from "./organizations/[organizationId]/route";

const memberParams = { params: Promise.resolve({ memberId: "mem_test/1" }) };
const organizationParams = { params: Promise.resolve({ organizationId: "org_test/1" }) };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Settings dashboard routes", () => {
  it.each<[string, (request: Request) => Promise<Response>, string]>([
    [
      "route.dashboard.members.api-keys",
      (request) => memberApiKeys(request, memberParams),
      "/v1/members/mem_test%2F1/api-keys",
    ],
    [
      "route.dashboard.members.update-role",
      (request) => changeMemberRole(request, memberParams),
      "/v1/members/mem_test%2F1",
    ],
    [
      "route.dashboard.members.remove",
      (request) => removeMember(request, memberParams),
      "/v1/members/mem_test%2F1",
    ],
    [
      "route.dashboard.members.invitation.revoke",
      (request) =>
        revokeInvitation(request, { params: Promise.resolve({ invitationId: "inv_test/1" }) }),
      "/v1/members/invitations/inv_test%2F1",
    ],
    ["route.dashboard.members.invite", (request) => inviteMember(request), "/v1/members/invite"],
    ["route.dashboard.members.leave", (request) => leaveOrganization(request), "/v1/members/me"],
    [
      "route.dashboard.organizations.update",
      (request) => updateOrganization(request, organizationParams),
      "/v1/organizations/org_test%2F1",
    ],
    [
      "route.dashboard.organizations.mainnet-access.request",
      (request) => requestMainnetAccess(request, organizationParams),
      "/v1/organizations/org_test%2F1/mainnet-access",
    ],
    [
      "route.dashboard.organizations.mainnet-access.notify",
      (request) => notifyMainnetAccess(request, organizationParams),
      "/v1/organizations/org_test%2F1/mainnet-access/notify",
    ],
  ])("%s proxies to its sdp-api path, the id encoded", async (traceSource, handle, path) => {
    const proxy = vi
      .spyOn(sdpApi, "proxyToSdpApi")
      .mockResolvedValue(NextResponse.json({ data: {} }));
    const request = new Request("https://dashboard.example.com/api/dashboard/settings");

    await handle(request);

    expect(proxy).toHaveBeenCalledWith({ request, traceSource, path });
  });
});
