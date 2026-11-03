import { beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import * as sdpApi from "@/lib/sdp-api";

const mocks = vi.hoisted(() => ({ getSdpAuth: vi.fn() }));

vi.mock("next/headers", () => import("@/test/next-headers"));
vi.mock("@/lib/sdp-auth", () => ({ getSdpAuth: mocks.getSdpAuth }));

import { readOrganizationsLinked } from "./organization-link-actions";

describe("readOrganizationsLinked", () => {
  let readOrganizationLinked: MockInstance<typeof sdpApi.readOrganizationLinked>;

  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.getSdpAuth.mockResolvedValue({ userId: "user_test", orgId: null });
    readOrganizationLinked = vi.spyOn(sdpApi, "readOrganizationLinked");
  });

  it("answers each token in order", async () => {
    readOrganizationLinked.mockImplementation(async (token) => token === "token_prod");

    await expect(readOrganizationsLinked(["token_prod", "token_beta"])).resolves.toEqual([
      true,
      false,
    ]);
  });

  it("refuses a caller who is not signed in", async () => {
    mocks.getSdpAuth.mockResolvedValue({ userId: null, orgId: null });

    await expect(readOrganizationsLinked(["token_prod"])).rejects.toThrow("Sign-in required");
    expect(readOrganizationLinked).not.toHaveBeenCalled();
  });

  it("refuses more tokens than one read takes", async () => {
    await expect(
      readOrganizationsLinked(Array.from({ length: 101 }, (_, index) => `token_${index}`))
    ).rejects.toThrow();
    expect(readOrganizationLinked).not.toHaveBeenCalled();
  });
});
