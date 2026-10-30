// @vitest-environment jsdom

import * as clerk from "@clerk/nextjs";
import type { OrganizationRole } from "@sdp/types/roles";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { DashboardWorkspaceProvider } from "@/contexts/dashboard-workspace-context";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { SANDBOX_PROJECT } from "@/test/projects";
import { dashboardFlagsAt } from "@/test/release-channel-flags";
import { restoreWindowLocation, setWindowPathname } from "@/test/window-location";
import { HeliusRingsWorkspace } from "./helius-rings-workspace";
import type { CustodyWalletOption } from "./private-wallets-card";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  restoreWindowLocation();
});

function renderWorkspace(custodyWallets: CustodyWalletOption[], role: OrganizationRole) {
  vi.spyOn(clerk, "useAuth");
  vi.mocked(clerk.useAuth, { partial: true }).mockReturnValue({ isLoaded: false });
  setWindowPathname(`/dashboard/${SANDBOX_PROJECT.id}/helius-rings`);
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = String(input);
    switch (path) {
      case "/api/dashboard/helius-rings/setup-status":
        return Response.json({
          data: {
            configured: true,
            source: "database",
            canManage: false,
            allowInsecureHttpAllowed: false,
            defaultConnection: null,
          },
        });
      case "/api/dashboard/helius-rings/health":
        return Response.json({
          data: { health: { rpc: "green", prover: "green", photon: "green" } },
        });
      case "/api/dashboard/helius-rings/wallets":
        return Response.json({
          data: {
            wallets: [
              {
                id: "hrw_treasury",
                custodyWalletId: "cwlt_bound",
                name: "Treasury",
                shieldedAddress: null,
                status: "pending",
                network: "devnet",
              },
            ],
          },
        });
      case "/api/dashboard/helius-rings/operations":
        if (init?.method === "POST") {
          return Response.json({ data: { operation: { id: "hro_withdraw" } } });
        }
        return Response.json({ data: { operations: [] } });
      case "/api/dashboard/helius-rings/rings":
        return Response.json({ data: { rings: [] } });
      default:
        throw new Error(`Unexpected request: ${path}`);
    }
  });
  render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <DashboardWorkspaceProvider
        scopeRefreshFallback={null}
        dashboardAccess={resolveDashboardAccess(role)}
        flags={dashboardFlagsAt("experimental")}
        serverDashboardCacheScope={{ orgId: "org_test", userId: "user_test" }}
        projects={[SANDBOX_PROJECT]}
      >
        <HeliusRingsWorkspace custodyWallets={custodyWallets} />
      </DashboardWorkspaceProvider>
    </I18nProvider>
  );
  return fetchSpy;
}

it("joins and filters the exact internal ID when inventory has no provider field", async () => {
  renderWorkspace(
    [
      { id: "cwlt_bound", label: "Bound custody", publicKey: "Same111" },
      { id: "cwlt_sibling", label: "Sibling custody", publicKey: "Same111" },
    ],
    "admin"
  );

  const row = await screen.findByRole("row", { name: /Treasury Bound custody/ });
  expect(within(row).getByText("Bound custody")).toBeTruthy();
  await userEvent.setup().click(screen.getByRole("combobox", { name: "Custody wallet" }));
  expect(await screen.findByRole("option", { name: "Sibling custody" })).toBeTruthy();
  expect(screen.queryByRole("option", { name: "Bound custody" })).toBeNull();
});

it("withdraws to the exact internal-ID inventory address without an owner field in the wallet", async () => {
  const destination = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
  const fetchSpy = renderWorkspace(
    [
      {
        id: "cwlt_sibling",
        label: "Sibling custody",
        publicKey: "11111111111111111111111111111111",
      },
      { id: "cwlt_bound", label: "Bound custody", publicKey: destination },
    ],
    "admin"
  );
  await screen.findByRole("row", { name: /Treasury Bound custody/ });
  const user = userEvent.setup();

  await user.click(screen.getByRole("tab", { name: "Withdraw" }));
  await user.type(screen.getByPlaceholderText("1.01"), "1.5");
  await user.click(screen.getByRole("button", { name: "Review" }));
  await user.click(screen.getByRole("button", { name: "Confirm" }));

  await waitFor(() =>
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/dashboard/helius-rings/operations",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining(`"to":"${destination}"`),
      })
    )
  );
});

it("shows the internal-ID wallet binding to a viewer without write controls", async () => {
  renderWorkspace(
    [
      { id: "cwlt_bound", label: "Bound custody", publicKey: "Same111" },
      { id: "cwlt_sibling", label: "Sibling custody", publicKey: "Same111" },
    ],
    "viewer"
  );

  await screen.findByRole("row", { name: /Treasury Bound custody/ });
  expect(screen.queryByRole("combobox", { name: "Custody wallet" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry provision" })).toBeNull();
  expect(screen.queryByRole("tab", { name: "Withdraw" })).toBeNull();
});
