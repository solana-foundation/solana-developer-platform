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

vi.mock("@/app/dashboard/[projectId]/custody/wallet-address-copy-button", () => ({
  WalletAddressCopyButton: () => null,
  WalletMetadataCopyButton: () => null,
}));

vi.mock("@/app/dashboard/[projectId]/custody/wallet-provider-mark", () => ({
  WalletProviderMark: () => <span>Provider mark</span>,
}));

vi.mock("@/app/dashboard/[projectId]/custody/connections/use-selected-project-name", () => ({
  useSelectedProjectName: () => "Acme Payments",
}));

import {
  type ConnectionsPageResult,
  type CustodyConnectionListItem,
  summarizeProviderConnections,
} from "@/app/dashboard/[projectId]/custody/connections/connections.data";
import { CustodyConnectionsSection } from "./custody-connections-section";

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
  projectConnections = connections,
  complete = true,
  canManageCustody = true,
}: {
  connections: CustodyConnectionListItem[];
  projectConnections?: CustodyConnectionListItem[];
  complete?: boolean;
  canManageCustody?: boolean;
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

describe("custody connections section", () => {
  it("explains a signing pause without implying anything was removed", () => {
    const html = render({
      connections: [makeConnection({ id: "cconn_1", isRuntimeExecutionAllowed: false })],
    });

    expect(html).toContain("Signing through your own credentials is currently not allowed");
    expect(html).toContain("Nothing has been deleted.");
    expect(html).toContain("Active");
  });

  it("does not pause signing over one paused connection among several", () => {
    const onPage = makeConnection({ id: "cconn_1", isRuntimeExecutionAllowed: false });
    const html = render({
      connections: [onPage],
      projectConnections: [onPage, makeConnection({ id: "cconn_2" })],
    });

    expect(html).not.toContain("Signing through your own credentials is currently not allowed");
  });

  it("does not pause signing when the project could not be read through", () => {
    const html = render({
      connections: [makeConnection({ id: "cconn_1", isRuntimeExecutionAllowed: false })],
      complete: false,
    });

    expect(html).not.toContain("Signing through your own credentials is currently not allowed");
  });

  it("names the role a read-only viewer is missing, and offers them no actions", () => {
    const html = render({
      connections: [makeConnection({ id: "cconn_1" })],
      canManageCustody: false,
    });

    expect(html).toContain("custody admin");
    expect(html).toContain("Settings");
    expect(html).not.toContain("Add connection");
  });
});
