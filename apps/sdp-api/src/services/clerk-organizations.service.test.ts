import { afterEach, describe, expect, it, vi } from "vitest";
import { ClerkOrganizationsService } from "@/services/clerk-organizations.service";
import { env } from "@/test/helpers/env";

describe("ClerkOrganizationsService.updateOrganizationPrivateMetadata", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Clerk rejects `private_metadata` on PATCH /organizations/{id} with a 422.
  it("replaces private metadata through the organization metadata endpoint", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ id: "org_1", private_metadata: {} }));
    const service = new ClerkOrganizationsService({ ...env, CLERK_SECRET_KEY: "sk_test_1" });

    await service.updateOrganizationPrivateMetadata("org_1", { sdp: { tier: "individual" } });

    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe("https://api.clerk.com/v1/organizations/org_1/metadata");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual({
      private_metadata: { sdp: { tier: "individual" } },
    });
  });
});
