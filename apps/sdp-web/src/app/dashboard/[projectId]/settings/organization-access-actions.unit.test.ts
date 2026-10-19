import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRODUCTION_PROJECT } from "@/test/projects";
import { setPageRequest } from "@/test/request-project";

const mocks = vi.hoisted(() => ({
  createOrgSdpApiClient: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/headers", () => import("@/test/next-headers"));
vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/lib/sdp-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sdp-api")>()),
  createOrgSdpApiClient: mocks.createOrgSdpApiClient,
}));

import {
  loadOrganizationIpAllowlist,
  saveOrganizationIpAllowlistAction,
} from "./organization-access-actions";

const client = { fetch: vi.fn() };

function respond(organizationSettings: unknown) {
  client.fetch.mockImplementation(async (path: string) =>
    path === "/v1/onboarding/status"
      ? { linked: true, organization: { id: "org_sdp" } }
      : { settings: organizationSettings }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  setPageRequest(`/dashboard/${PRODUCTION_PROJECT.id}/settings`);
  mocks.createOrgSdpApiClient.mockResolvedValue(client);
});

describe("organization IP allowlist", () => {
  it("loads the stored allowlist, empty when unrestricted", async () => {
    respond({});
    expect(await loadOrganizationIpAllowlist()).toEqual({
      ok: true,
      organizationId: "org_sdp",
      allowedIps: [],
    });
  });

  it("saves one entry per address and returns the stored list", async () => {
    respond({ allowedIpAddresses: ["203.0.113.0/24"] });

    const result = await saveOrganizationIpAllowlistAction("203.0.113.5/24\n203.0.113.5/24, ");

    expect(result).toEqual({ ok: true, allowedIps: ["203.0.113.0/24"] });
    const [path, init] = client.fetch.mock.calls.at(-1) ?? [];
    expect(path).toBe("/v1/organizations/org_sdp");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({
      settings: { allowedIpAddresses: ["203.0.113.5/24"] },
    });
  });

  it("clears the allowlist with an empty list", async () => {
    respond({ allowedIpAddresses: [] });

    await saveOrganizationIpAllowlistAction("   ");

    expect(JSON.parse(String(client.fetch.mock.calls.at(-1)?.[1]?.body))).toEqual({
      settings: { allowedIpAddresses: [] },
    });
  });

  it("reports an API refusal without throwing", async () => {
    client.fetch.mockRejectedValue(new Error("Must be a valid IPv4 or IPv6 address"));

    const result = await saveOrganizationIpAllowlistAction("office");

    expect(result.ok).toBe(false);
  });
});
