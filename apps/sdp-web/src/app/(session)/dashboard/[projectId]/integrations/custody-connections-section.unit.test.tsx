import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock(
  "@/app/(session)/dashboard/[projectId]/wallets/connections/use-selected-project-name",
  () => ({
    useSelectedProjectName: () => "Acme Payments",
  })
);

import {
  type ConnectionsPageResult,
  type CustodyConnectionListItem,
  summarizeProviderConnections,
} from "@/app/(session)/dashboard/[projectId]/wallets/connections/connections.data";
import {
  CustodyConnectionsSection,
  CustodyConnectionsSigningLine,
} from "./custody-connections-section";

const ADD_CONNECTION_HREF = 'href="/dashboard/prj_test_sandbox/integrations/privy/connections/new"';

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

function render({
  connections,
  projectConnections,
  complete,
  canManageCustody,
}: {
  connections: CustodyConnectionListItem[];
  projectConnections: CustodyConnectionListItem[];
  complete: boolean;
  canManageCustody: boolean;
}): string {
  const result: ConnectionsPageResult = {
    connections,
    pagination: { limit: 20, offset: 0, total: projectConnections.length },
  };
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <CustodyConnectionsSection
        result={result}
        filters={{ page: 1 }}
        summary={summarizeProviderConnections({ connections: projectConnections, complete })}
        walletsByConnection={{}}
        walletsUnavailable={false}
        canManageCustody={canManageCustody}
        provider="privy"
      />
    </I18nProvider>
  );
}

function renderSigningLine(
  total: number,
  connections: CustodyConnectionListItem[],
  complete: boolean
) {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <CustodyConnectionsSigningLine
        total={total}
        summary={summarizeProviderConnections({ connections, complete })}
      />
    </I18nProvider>
  );
}

describe("custody connections section", () => {
  it("explains a signing pause without implying anything was removed", () => {
    const paused = makeConnection({ id: "cconn_1", isRuntimeExecutionAllowed: false });
    const html = render({
      connections: [paused],
      projectConnections: [paused],
      complete: true,
      canManageCustody: true,
    });

    expect(html).toContain("Signing through your own credentials is currently not allowed");
    expect(html).toContain("Nothing has been deleted.");
    expect(html).toContain('data-connection-id="cconn_1"');
  });

  it("does not pause signing over one paused connection among several", () => {
    const onPage = makeConnection({ id: "cconn_1", isRuntimeExecutionAllowed: false });
    const html = render({
      connections: [onPage],
      projectConnections: [onPage, makeConnection({ id: "cconn_2" })],
      complete: true,
      canManageCustody: true,
    });

    expect(html).not.toContain("Signing through your own credentials is currently not allowed");
  });

  it("does not pause signing when the project could not be read through", () => {
    const paused = makeConnection({ id: "cconn_1", isRuntimeExecutionAllowed: false });
    const html = render({
      connections: [paused],
      projectConnections: [paused],
      complete: false,
      canManageCustody: true,
    });

    expect(html).not.toContain("Signing through your own credentials is currently not allowed");
  });

  it("names the role a read-only viewer is missing, and offers them no actions", () => {
    const connection = makeConnection({ id: "cconn_1" });
    const html = render({
      connections: [connection],
      projectConnections: [connection],
      complete: true,
      canManageCustody: false,
    });

    expect(html).toContain("custody admin");
    expect(html).toContain("Settings");
    expect(html).not.toContain("Add connection");
  });

  it("links Add connection to the new connection page from the heading once rows exist", () => {
    const connection = makeConnection({ id: "cconn_1" });
    const html = render({
      connections: [connection],
      projectConnections: [connection],
      complete: true,
      canManageCustody: true,
    });

    expect(html.split(ADD_CONNECTION_HREF)).toHaveLength(2);
    expect(html.indexOf(ADD_CONNECTION_HREF)).toBeLessThan(html.indexOf("<table"));
  });

  it("moves Add connection into the empty state when the project has no connections", () => {
    const html = render({
      connections: [],
      projectConnections: [],
      complete: true,
      canManageCustody: true,
    });

    expect(html.split(ADD_CONNECTION_HREF)).toHaveLength(2);
    expect(html.indexOf("No connections in Acme Payments yet")).toBeLessThan(
      html.indexOf(ADD_CONNECTION_HREF)
    );
  });
});

describe("custody connections signing line", () => {
  const paused = makeConnection({ id: "cconn_1", isRuntimeExecutionAllowed: false });
  const signing = makeConnection({ id: "cconn_2" });

  it("says the project has none yet", () => {
    expect(renderSigningLine(0, [], true)).toBe("No connections in Acme Payments yet");
  });

  it("gives the count alone when the summary could not see every connection", () => {
    expect(renderSigningLine(150, [paused, signing], false)).toBe(
      "150 connections in Acme Payments"
    );
  });

  it("says how many of the project's connections can sign", () => {
    expect(renderSigningLine(2, [paused, signing], true)).toBe(
      "1 of 2 connections can sign in Acme Payments."
    );
  });
});
