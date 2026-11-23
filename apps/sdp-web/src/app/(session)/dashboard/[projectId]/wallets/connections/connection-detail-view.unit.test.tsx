// @vitest-environment jsdom

import type { CustodyWalletSummary } from "@sdp/types/custody";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as byokActions from "@/app/(session)/dashboard/[projectId]/wallets/byok-actions";
import {
  DashboardPageTitleContext,
  type DashboardPageTitleOverride,
} from "@/components/dashboard-page-title-context";
import { stubClerkSession } from "@/test/clerk";
import { dashboardRouter, resetDashboardNavigation } from "@/test/dashboard-navigation";
import { syntheticWalletAddress, walletsWorkspace } from "@/test/wallets";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

import type {
  CustodyCredentialLifecycle,
  CustodyInstallationConnection,
} from "./connection-detail.data";
import { ConnectionDetailView } from "./connection-detail-view";

beforeEach(() => {
  stubClerkSession();
});

afterEach(() => {
  cleanup();
  resetDashboardNavigation();
  vi.restoreAllMocks();
});

function makeConnection(
  overrides: Partial<CustodyInstallationConnection>
): CustodyInstallationConnection {
  return {
    id: "cconn_1",
    provider: "privy",
    label: "Production signing",
    status: "pending",
    completion: null,
    canComplete: true,
    canReplaceCredentials: true,
    canCancel: true,
    ...overrides,
  };
}

const ACTIVE = makeConnection({ status: "active", canComplete: false, canCancel: false });
const DEACTIVATED = makeConnection({ status: "deactivated", canComplete: false, canCancel: false });

function makeWallet(
  walletId: string,
  status: CustodyWalletSummary["status"],
  purpose: string | null
): CustodyWalletSummary {
  return {
    id: `cw_${walletId}`,
    custodyConnectionId: "cconn_1",
    isRuntimeExecutionAllowed: true,
    walletId,
    publicKey: syntheticWalletAddress(1),
    label: `Wallet ${walletId}`,
    purpose,
    status,
    createdAt: "2026-09-17T13:20:00.000Z",
  };
}

function makeLifecycle(
  connections: CustodyCredentialLifecycle["impact"]["connections"]
): CustodyCredentialLifecycle {
  return {
    providerCredential: {
      id: "pcred_current",
      provider: "privy",
      label: "Privy production app",
      scope: "project",
      projectId: "prj_1",
      status: "active",
      createdAt: "2026-09-09T14:20:00.000Z",
      displayMetadata: { appIdSuffix: "9f2a" },
      source: "stored",
    },
    rotationCandidate: null,
    impact: { projects: [{ id: "prj_1", name: "Acme Payments" }], connections },
    rollback: null,
  };
}

const IN_USE = makeLifecycle([{ id: "cconn_1", projectId: "prj_1", status: "active" }]);
const UNUSED = makeLifecycle([]);

/** Stands in for the shell's header, which shows what the page hands it. */
function HeaderHost({ children }: { children: ReactNode }) {
  const [header, setHeader] = useState<DashboardPageTitleOverride | null>(null);
  return (
    <DashboardPageTitleContext.Provider value={setHeader}>
      {header ? (
        <header>
          <h1>{header.title}</h1>
          {header.badge}
          {header.actions}
        </header>
      ) : null}
      {children}
    </DashboardPageTitleContext.Provider>
  );
}

function renderView({
  connection,
  wallets = [],
  lifecycle = "restricted",
  canManageCustody = true,
}: {
  connection: CustodyInstallationConnection;
  wallets?: CustodyWalletSummary[];
  lifecycle?: CustodyCredentialLifecycle | "restricted";
  canManageCustody?: boolean;
}) {
  render(
    <HeaderHost>
      <ConnectionDetailView
        connection={connection}
        listItem={null}
        lifecycle={lifecycle}
        wallets={wallets}
        walletsUnavailable={false}
        provider="privy"
        canManageCustody={canManageCustody}
      />
    </HeaderHost>,
    { wrapper: walletsWorkspace(canManageCustody ? "admin" : "member") }
  );
}

const UNFINISHED_TITLE = /Setup is not finished/;
const UNKNOWN_TITLE = /We could not confirm whether verification finished/;

const button = (name: string) => screen.queryByRole("button", { name });

describe("connection detail banners", () => {
  const unknownCompletion = {
    status: "retry_unknown" as const,
    attemptedAt: "2026-09-17T13:20:00.000Z",
  };

  // The two used to stack, each with its own re-check button.
  it("states an unconfirmed outcome once, with both ways out of the setup", () => {
    renderView({ connection: makeConnection({ completion: unknownCompletion }) });

    expect(screen.getByText(UNKNOWN_TITLE)).toBeTruthy();
    expect(screen.queryByText(UNFINISHED_TITLE)).toBeNull();
    expect(button("Check current state")).not.toBeNull();
    expect(button("Cancel setup")).not.toBeNull();
  });

  it("re-runs the same connection's completion from the banner, then re-reads the page", async () => {
    const recheck = vi
      .spyOn(byokActions, "recheckPrivyCredentialAction")
      .mockResolvedValue({ status: "retry_unknown", connectionId: "cconn_1" });
    renderView({ connection: makeConnection({ completion: unknownCompletion }) });

    await userEvent.click(screen.getByRole("button", { name: "Check current state" }));

    await waitFor(() => expect(dashboardRouter.refresh).toHaveBeenCalledOnce());
    expect(recheck.mock.calls).toEqual([["cconn_1"]]);
  });

  it("offers no action a viewer without the role could take", () => {
    renderView({
      connection: makeConnection({ completion: unknownCompletion }),
      canManageCustody: false,
    });

    expect(screen.getByText(UNKNOWN_TITLE)).toBeTruthy();
    expect(button("Check current state")).toBeNull();
    expect(button("Cancel setup")).toBeNull();
  });

  // Nothing has been attempted yet, so there is no outcome to report, only the state.
  it("falls back to the generic banner when no attempt was recorded", () => {
    renderView({ connection: makeConnection({ completion: null }) });

    expect(screen.getByText(UNFINISHED_TITLE)).toBeTruthy();
    expect(screen.queryByText(UNKNOWN_TITLE)).toBeNull();
  });

  it("leaves a settled connection with no banner at all", () => {
    renderView({
      connection: {
        ...ACTIVE,
        completion: { status: "success", attemptedAt: "2026-09-17T13:20:00.000Z" },
      },
    });

    expect(screen.queryByText(UNFINISHED_TITLE)).toBeNull();
    expect(screen.queryByText(UNKNOWN_TITLE)).toBeNull();
  });

  // Re-checking cannot reconcile a wallet conflict, so the retry is withheld even though the
  // viewer may act and the API would accept the call.
  it("withholds the retry on an outcome that cannot converge", () => {
    renderView({
      connection: makeConnection({
        status: "failed",
        completion: {
          status: "failed",
          attemptedAt: "2026-09-17T13:20:00.000Z",
          code: "wallet_conflict",
        },
      }),
    });

    expect(button("Check again")).toBeNull();
    expect(button("Cancel setup")).not.toBeNull();
  });
});

describe("connection header", () => {
  it("names the connection with its status and starts a rotation from Rotate secret", async () => {
    renderView({ connection: ACTIVE, lifecycle: IN_USE });
    const header = screen.getByRole("banner");

    expect(within(header).getByRole("heading", { name: "Production signing" })).toBeTruthy();
    expect(within(header).getByText("Active")).toBeTruthy();
    await userEvent.click(within(header).getByRole("button", { name: "Rotate secret" }));
    expect(await screen.findByRole("dialog", { name: "Rotate credentials" })).toBeTruthy();
  });
});

describe("connection wallets", () => {
  it("lists each wallet under its provider, state and purpose with a short address", () => {
    renderView({
      connection: ACTIVE,
      wallets: [
        makeWallet("wal_ops", "active", "Treasury"),
        makeWallet("wal_old", "inactive", null),
        makeWallet("wal_fees", "active", "fee_payer"),
      ],
    });

    expect(screen.getByRole("link", { name: "Wallet wal_ops" }).getAttribute("href")).toBe(
      "/dashboard/prj_test_sandbox/wallets/wal_ops"
    );
    expect(screen.getByText("Privy · Treasury")).toBeTruthy();
    expect(screen.getByText("Privy · inactive")).toBeTruthy();
    expect(screen.getByText("Privy · Fee payer")).toBeTruthy();
    expect(screen.getAllByText("1113...gSA2")).toHaveLength(3);
    expect(button("Add wallet")).not.toBeNull();
  });

  it("marks wallets read-only and offers no new one once the connection is deactivated", () => {
    renderView({ connection: DEACTIVATED, wallets: [makeWallet("wal_ops", "active", "Treasury")] });

    expect(screen.getByText("Privy · Read-only · Treasury")).toBeTruthy();
    expect(button("Add wallet")).toBeNull();
  });
});

describe("danger zone", () => {
  it.each([
    ["an unfinished setup", makeConnection({}), [], true, null, false],
    [
      "an active wallet",
      ACTIVE,
      [makeWallet("wal_ops", "active", null)],
      true,
      "1 wallet still active",
      false,
    ],
    ["only inactive wallets", ACTIVE, [makeWallet("wal_old", "inactive", null)], true, null, true],
    ["a viewer who cannot manage custody", ACTIVE, [], false, null, false],
  ] as const)(
    "decides the deactivate-connection control for %s",
    (_case, connection, wallets, canManageCustody, disclosure, offered) => {
      renderView({ connection, wallets: [...wallets], canManageCustody });

      expect(screen.getByText("Danger zone")).toBeTruthy();
      if (disclosure === null) {
        expect(screen.queryByText(/still active/)).toBeNull();
      } else {
        expect(button(disclosure)).not.toBeNull();
      }
      expect(button("Deactivate connection") !== null).toBe(offered);
    }
  );

  it("lists the active wallets that block deactivation as links", async () => {
    renderView({
      connection: ACTIVE,
      wallets: [
        makeWallet("wal_ops", "active", null),
        makeWallet("wal_pay", "active", null),
        makeWallet("wal_old", "inactive", null),
      ],
    });
    const disclosure = screen.getByRole("button", { name: "2 wallets still active" });

    await userEvent.click(disclosure);

    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    const linksTo = (name: string) =>
      screen.getAllByRole("link", { name }).map((link) => link.getAttribute("href"));
    // Each wallet's own row, plus the blocking list for the active ones.
    expect(linksTo("Wallet wal_ops")).toEqual([
      "/dashboard/prj_test_sandbox/wallets/wal_ops",
      "/dashboard/prj_test_sandbox/wallets/wal_ops",
    ]);
    expect(linksTo("Wallet wal_pay")).toHaveLength(2);
    expect(linksTo("Wallet wal_old")).toHaveLength(1);
  });

  it.each([
    ["restricted", "restricted", false],
    ["unused stored", UNUSED, true],
  ] as const)(
    "shows a deactivated connection's danger zone only for deactivatable credentials (%s)",
    (_case, lifecycle, shown) => {
      renderView({ connection: DEACTIVATED, lifecycle });

      expect(screen.queryByText("Danger zone") !== null).toBe(shown);
      expect(button("Deactivate credentials") !== null).toBe(shown);
      expect(button("Deactivate connection")).toBeNull();
    }
  );

  it("opens the credential deactivation from its row", async () => {
    renderView({ connection: DEACTIVATED, lifecycle: UNUSED });

    await userEvent.click(screen.getByRole("button", { name: "Deactivate credentials" }));

    expect(
      await screen.findByRole("dialog", { name: "Deactivate “Privy production app” credentials?" })
    ).toBeTruthy();
  });
});
