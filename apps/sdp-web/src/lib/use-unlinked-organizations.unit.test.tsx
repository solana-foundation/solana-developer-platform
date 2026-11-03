// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import * as organizationLinkActions from "@/app/dashboard/organization-link-actions";
import { useUnlinkedOrganizations } from "./use-unlinked-organizations";

const mocks = vi.hoisted(() => ({
  getToken: vi.fn<(options: { organizationId: string }) => Promise<string | null>>(),
  userId: "user_test" as string | null,
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: mocks.getToken, userId: mocks.userId }),
}));

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
  );
}

describe("useUnlinkedOrganizations", () => {
  let readOrganizationsLinked: MockInstance<typeof organizationLinkActions.readOrganizationsLinked>;

  beforeEach(() => {
    vi.restoreAllMocks();
    readOrganizationsLinked = vi.spyOn(organizationLinkActions, "readOrganizationsLinked");
    mocks.userId = "user_test";
    mocks.getToken.mockImplementation(async ({ organizationId }) => `token_${organizationId}`);
  });

  it("hides only the organizations SDP answers linked: false for", async () => {
    readOrganizationsLinked.mockImplementation(async (tokens) =>
      tokens.map((token) => token !== "token_org_beta")
    );

    const { result } = renderHook(() => useUnlinkedOrganizations(["org_prod", "org_beta"]), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isResolved).toBe(true));
    expect([...result.current.unlinkedIds]).toEqual(["org_beta"]);
    expect(mocks.getToken).toHaveBeenCalledWith({ organizationId: "org_beta" });
  });

  it("resolves with nothing hidden when Clerk mints no token", async () => {
    mocks.getToken.mockResolvedValue(null);

    const { result } = renderHook(() => useUnlinkedOrganizations(["org_beta"]), { wrapper });

    await waitFor(() => expect(result.current.isResolved).toBe(true));
    expect(result.current.unlinkedIds.size).toBe(0);
    expect(readOrganizationsLinked).not.toHaveBeenCalled();
  });

  it("resolves with nothing hidden when the read fails", async () => {
    readOrganizationsLinked.mockRejectedValue(new Error("unavailable"));

    const { result } = renderHook(() => useUnlinkedOrganizations(["org_beta"]), { wrapper });

    await waitFor(() => expect(result.current.isResolved).toBe(true));
    expect(result.current.unlinkedIds.size).toBe(0);
  });

  it("asks nothing with no organizations or no signed-in person", () => {
    const empty = renderHook(() => useUnlinkedOrganizations([]), { wrapper });
    mocks.userId = null;
    const signedOut = renderHook(() => useUnlinkedOrganizations(["org_beta"]), { wrapper });

    expect(empty.result.current.isResolved).toBe(true);
    expect(signedOut.result.current.isResolved).toBe(true);
    expect(readOrganizationsLinked).not.toHaveBeenCalled();
  });
});
