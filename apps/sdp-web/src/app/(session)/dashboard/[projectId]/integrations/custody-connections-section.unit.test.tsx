// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubClerkSession } from "@/test/clerk";
import { resetDashboardNavigation } from "@/test/dashboard-navigation";
import { walletsWorkspace } from "@/test/wallets";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

import {
  type ConnectionsPageResult,
  type CustodyConnectionListItem,
  summarizeProviderConnections,
} from "@/app/(session)/dashboard/[projectId]/wallets/connections/connections.data";
import {
  CustodyConnectionsSection,
  CustodyConnectionsSigningLine,
} from "./custody-connections-section";

const ADD_CONNECTION_HREF = "/dashboard/prj_test_sandbox/integrations/privy/connections/new";
const SIGNING_PAUSED = "Signing through your own credentials is currently not allowed";

const workspace = walletsWorkspace("admin");

beforeEach(() => {
  stubClerkSession();
});

afterEach(() => {
  cleanup();
  resetDashboardNavigation();
  vi.restoreAllMocks();
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
    label: "Production signing",
    isRuntimeExecutionAllowed: true,
    ...overrides,
  };
}

function renderSection({
  connections,
  projectConnections,
  complete,
  canManageCustody,
}: {
  connections: CustodyConnectionListItem[];
  projectConnections: CustodyConnectionListItem[];
  complete: boolean;
  canManageCustody: boolean;
}) {
  const result: ConnectionsPageResult = {
    connections,
    pagination: { limit: 20, offset: 0, total: projectConnections.length },
  };
  render(
    <CustodyConnectionsSection
      result={result}
      filters={{ page: 1 }}
      summary={summarizeProviderConnections({ connections: projectConnections, complete })}
      walletsByConnection={{}}
      walletsUnavailable={false}
      canManageCustody={canManageCustody}
      provider="privy"
    />,
    { wrapper: workspace }
  );
}

function signingLine(total: number, connections: CustodyConnectionListItem[], complete: boolean) {
  const { container } = render(
    <CustodyConnectionsSigningLine
      total={total}
      summary={summarizeProviderConnections({ connections, complete })}
    />,
    { wrapper: workspace }
  );
  return container.textContent;
}

function addConnectionLinks(): (string | null)[] {
  return screen
    .queryAllByRole("link", { name: "Add connection" })
    .map((link) => link.getAttribute("href"));
}

describe("custody connections section", () => {
  it("explains a signing pause without implying anything was removed", () => {
    const paused = makeConnection({ id: "cconn_1", isRuntimeExecutionAllowed: false });
    renderSection({
      connections: [paused],
      projectConnections: [paused],
      complete: true,
      canManageCustody: true,
    });

    expect(screen.getByText(new RegExp(SIGNING_PAUSED))).toBeTruthy();
    expect(screen.getByText(/Nothing has been deleted\./)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Production signing" }).getAttribute("href")).toBe(
      "/dashboard/prj_test_sandbox/integrations/privy/connections/cconn_1"
    );
  });

  // The banner is a claim about the whole project: one paused row among several, or a read that
  // could not see every connection, does not support it.
  it.each([
    [
      "one paused connection among several",
      [
        makeConnection({ id: "cconn_1", isRuntimeExecutionAllowed: false }),
        makeConnection({ id: "cconn_2" }),
      ],
      true,
    ],
    [
      "a project read that could not see every connection",
      [makeConnection({ id: "cconn_1", isRuntimeExecutionAllowed: false })],
      false,
    ],
  ])("does not pause signing over %s", (_case, projectConnections, complete) => {
    renderSection({
      connections: projectConnections.slice(0, 1),
      projectConnections,
      complete,
      canManageCustody: true,
    });

    expect(screen.queryByText(new RegExp(SIGNING_PAUSED))).toBeNull();
  });

  it("names the role a read-only viewer is missing, and offers them no actions", () => {
    const connection = makeConnection({ id: "cconn_1" });
    renderSection({
      connections: [connection],
      projectConnections: [connection],
      complete: true,
      canManageCustody: false,
    });

    expect(screen.getByText(/custody admin/)).toBeTruthy();
    expect(addConnectionLinks()).toEqual([]);
  });

  it("offers Add connection once, with rows or without", () => {
    const connection = makeConnection({ id: "cconn_1" });
    renderSection({
      connections: [connection],
      projectConnections: [connection],
      complete: true,
      canManageCustody: true,
    });
    expect(addConnectionLinks()).toEqual([ADD_CONNECTION_HREF]);
    cleanup();

    renderSection({
      connections: [],
      projectConnections: [],
      complete: true,
      canManageCustody: true,
    });
    expect(screen.getByText("No connections in Sandbox yet")).toBeTruthy();
    expect(addConnectionLinks()).toEqual([ADD_CONNECTION_HREF]);
  });
});

describe("custody connections signing line", () => {
  const paused = makeConnection({ id: "cconn_1", isRuntimeExecutionAllowed: false });
  const signing = makeConnection({ id: "cconn_2" });

  it("says the project has none yet", () => {
    expect(signingLine(0, [], true)).toBe("No connections in Sandbox yet");
  });

  it("gives the count alone when the summary could not see every connection", () => {
    expect(signingLine(150, [paused, signing], false)).toBe("150 connections in Sandbox");
  });

  it("says how many of the project's connections can sign", () => {
    expect(signingLine(2, [paused, signing], true)).toBe("1 of 2 connections can sign in Sandbox.");
  });
});
