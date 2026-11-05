// @vitest-environment jsdom

import type { CustodyWalletSummary } from "@sdp/types/custody";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MouseEvent, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { dashboardRouter, resetDashboardNavigation } from "@/test/dashboard-navigation";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href} onClick={(event: MouseEvent) => event.preventDefault()}>
      {children}
    </a>
  ),
}));

import type { ConnectionsPageResult, CustodyConnectionListItem } from "./connections.data";
import { ConnectionsList } from "./connections-list";

afterEach(() => {
  cleanup();
  resetDashboardNavigation();
});

function makeConnection(
  overrides: Partial<CustodyConnectionListItem> & { id: string }
): CustodyConnectionListItem {
  return {
    provider: "privy",
    status: "active",
    createdAt: "2026-08-10T09:00:00.000Z",
    activatedAt: "2026-08-10T09:05:00.000Z",
    lastCheck: { status: "success", at: "2026-08-10T09:05:00.000Z", failureCode: null },
    pendingWalletLabel: null,
    label: "Ops Privy app",
    isRuntimeExecutionAllowed: true,
    ...overrides,
  };
}

function makeWallet(id: string): CustodyWalletSummary {
  return {
    id,
    custodyConnectionId: "conn_test_a91c",
    provider: "privy",
    isRuntimeExecutionAllowed: true,
    walletId: `${id}_provider`,
    publicKey: "ByokPublicKey11111111111111111111111111111",
    label: "Treasury",
    purpose: "transfer",
    status: "active",
    createdAt: "2026-08-10T09:05:00.000Z",
  };
}

function renderList({
  connections,
  total,
  walletsByConnection,
  walletsUnavailable,
  emptyStateAction,
}: {
  connections: CustodyConnectionListItem[];
  total: number;
  walletsByConnection: Record<string, CustodyWalletSummary[]>;
  walletsUnavailable: boolean;
  emptyStateAction: ReactNode;
}) {
  const result: ConnectionsPageResult = {
    connections,
    pagination: { limit: 20, offset: 0, total },
  };
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <ConnectionsList
        result={result}
        filters={{ page: 1 }}
        walletsByConnection={walletsByConnection}
        walletsUnavailable={walletsUnavailable}
        provider="privy"
        projectName="Acme Payments"
        emptyStateAction={emptyStateAction}
      />
    </I18nProvider>
  );
}

function connectionCell(container: HTMLElement, connectionId: string): string {
  const cell = container.querySelector(`[data-connection-id="${connectionId}"] td`);
  if (!cell) throw new Error(`no row for ${connectionId}`);
  return cell.textContent;
}

describe("connections list", () => {
  it.each([
    ["one wallet", [makeWallet("wal_test_1")], false, null, "1 wallet"],
    [
      "several wallets",
      [makeWallet("wal_test_1"), makeWallet("wal_test_2")],
      false,
      null,
      "2 wallets",
    ],
    ["an unreadable wallet list", [], true, null, "Wallets unavailable right now"],
    ["a wallet still activating", [], false, "Treasury", "Wallet pending activation"],
    ["no wallets", [], false, null, "No wallets yet"],
  ])(
    "summarises an active connection with %s by what it holds",
    (_case, wallets, walletsUnavailable, pendingWalletLabel, summary) => {
      const { container } = renderList({
        connections: [makeConnection({ id: "conn_test_a91c", pendingWalletLabel })],
        total: 1,
        walletsByConnection: { conn_test_a91c: wallets },
        walletsUnavailable,
        emptyStateAction: null,
      });

      expect(connectionCell(container, "conn_test_a91c")).toBe(`Ops Privy app····a91c${summary}`);
    }
  );

  it("adds that signing is disabled to an active connection the API would refuse", () => {
    const { container } = renderList({
      connections: [makeConnection({ id: "conn_test_a91c", isRuntimeExecutionAllowed: false })],
      total: 1,
      walletsByConnection: { conn_test_a91c: [makeWallet("wal_test_1")] },
      walletsUnavailable: false,
      emptyStateAction: null,
    });

    expect(connectionCell(container, "conn_test_a91c")).toBe(
      "Ops Privy app····a91c1 wallet · Signing is disabled"
    );
    expect(container.querySelector('[data-signing-state="paused"]')).not.toBeNull();
  });

  it("leads a failed connection with its state and the reason it failed", () => {
    const { container } = renderList({
      connections: [
        makeConnection({
          id: "conn_test_b72d",
          status: "failed",
          activatedAt: null,
          lastCheck: {
            status: "failed",
            at: "2026-08-11T09:00:00.000Z",
            failureCode: "invalid_credentials",
          },
        }),
      ],
      total: 1,
      walletsByConnection: {},
      walletsUnavailable: false,
      emptyStateAction: null,
    });

    expect(connectionCell(container, "conn_test_b72d")).toBe(
      "Ops Privy app····b72dFailed · Credentials were rejected"
    );
  });

  it.each([
    ["pending", "Pending"],
    ["checking", "Checking"],
    ["deactivated", "Deactivated"],
  ] as const)("summarises a %s connection by its state alone", (status, label) => {
    const { container } = renderList({
      connections: [
        makeConnection({
          id: "conn_test_c83e",
          status,
          activatedAt: null,
          pendingWalletLabel: "Treasury",
        }),
      ],
      total: 1,
      walletsByConnection: {},
      walletsUnavailable: false,
      emptyStateAction: null,
    });

    expect(connectionCell(container, "conn_test_c83e")).toBe(`Ops Privy app····c83e${label}`);
  });

  it("opens a connection from anywhere on its row, and leaves the name to its own link", async () => {
    const user = userEvent.setup();
    renderList({
      connections: [
        makeConnection({ id: "conn_test_a91c", label: "Shared Privy app" }),
        makeConnection({ id: "conn_test_b72d", label: "Shared Privy app" }),
      ],
      total: 2,
      walletsByConnection: {},
      walletsUnavailable: false,
      emptyStateAction: null,
    });

    const links = screen.getAllByRole("link", { name: "Shared Privy app" });
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/dashboard/prj_test_sandbox/integrations/privy/connections/conn_test_a91c",
      "/dashboard/prj_test_sandbox/integrations/privy/connections/conn_test_b72d",
    ]);

    await user.click(screen.getByText("····b72d"));
    expect(dashboardRouter.push).toHaveBeenCalledExactlyOnceWith(
      "/dashboard/prj_test_sandbox/integrations/privy/connections/conn_test_b72d"
    );

    await user.click(links[0]);
    expect(dashboardRouter.push).toHaveBeenCalledOnce();
  });

  it("renders the empty state for an empty slice even when a stale total disagrees", () => {
    const { container } = renderList({
      connections: [],
      total: 20,
      walletsByConnection: {},
      walletsUnavailable: false,
      emptyStateAction: <button type="button">Add connection</button>,
    });

    expect(screen.getByText("No connections in Acme Payments yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add connection" })).toBeTruthy();
    expect(container.querySelector("[data-connection-id]")).toBeNull();
  });

  it("paginates only past one page", () => {
    const connections = [makeConnection({ id: "conn_test_a91c" })];
    const single = renderList({
      connections,
      total: 1,
      walletsByConnection: {},
      walletsUnavailable: false,
      emptyStateAction: null,
    });
    expect(screen.queryByText(/Page 1 of/)).toBeNull();
    single.unmount();

    renderList({
      connections,
      total: 45,
      walletsByConnection: {},
      walletsUnavailable: false,
      emptyStateAction: null,
    });
    expect(screen.getByText("Page 1 of 3")).toBeTruthy();
  });
});
