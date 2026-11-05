// @vitest-environment jsdom
import type { OrganizationRole } from "@sdp/types/roles";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import {
  dashboardDataResponse,
  dashboardErrorResponse,
  sentDashboardReads,
  stubDashboardFetch,
} from "@/test/dashboard-fetch";
import { resetDashboardNavigation } from "@/test/dashboard-navigation";
import { EnglishDashboardReads } from "@/test/dashboard-reads";
import { ApiKeysWorkspace } from "./api-keys-workspace";

const workspace = vi.hoisted((): { role: OrganizationRole } => ({ role: "admin" }));

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({ dashboardAccess: resolveDashboardAccess(workspace.role) }),
}));
vi.mock("./api-key-flash-surface", () => ({ ApiKeyFlashSurface: () => null }));

const API_KEYS_URL = "/api/dashboard/api-keys";
const WALLETS_URL = "/api/dashboard/wallets?view=summary";

function apiKeys(): Response {
  return dashboardDataResponse(200, {
    apiKeys: [
      {
        id: "key_test_1",
        name: "Payouts",
        keyPrefix: "sk_test_abc",
        grants: ["transfers.read"],
        environment: "sandbox",
        status: "active",
        walletScope: "all",
        walletIds: [],
        lastUsedAt: null,
        expiresAt: null,
        rotationDeadline: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      },
    ],
  });
}

beforeEach(() => {
  resetDashboardNavigation();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ApiKeysWorkspace", () => {
  it.each<[OrganizationRole, string[]]>([
    ["admin", [API_KEYS_URL, WALLETS_URL]],
    ["member", [API_KEYS_URL]],
  ])(
    "shows a skeleton, then the keys, reading wallet names only for an %s who manages keys",
    async (role, reads) => {
      workspace.role = role;
      const fetchMock = stubDashboardFetch(({ path }) =>
        path === API_KEYS_URL ? apiKeys() : dashboardDataResponse(200, { wallets: [] })
      );

      const { container } = render(<ApiKeysWorkspace />, { wrapper: EnglishDashboardReads });

      expect(container.querySelector('[data-loading-layout="api-keys-list"]')).not.toBeNull();
      expect(await screen.findByText("Payouts")).toBeTruthy();
      await waitFor(() =>
        expect(sentDashboardReads(fetchMock).map(({ path }) => path)).toEqual(reads)
      );
    }
  );

  it("says the keys could not be loaded, and reads them again on retry", async () => {
    workspace.role = "member";
    const fetchMock = stubDashboardFetch(() =>
      fetchMock.mock.calls.length === 1
        ? dashboardErrorResponse(503, "upstream unavailable")
        : apiKeys()
    );
    const user = userEvent.setup();
    render(<ApiKeysWorkspace />, { wrapper: EnglishDashboardReads });

    expect((await screen.findByRole("alert")).textContent).toContain(
      "API keys could not be loaded."
    );
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Payouts")).toBeTruthy();
  });
});
