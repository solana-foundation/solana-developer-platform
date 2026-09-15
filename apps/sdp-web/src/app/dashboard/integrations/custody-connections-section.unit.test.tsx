import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => "/dashboard/integrations/privy",
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@/app/dashboard/custody/wallet-address-copy-button", () => ({
  WalletAddressCopyButton: () => null,
  WalletMetadataCopyButton: () => null,
}));

vi.mock("@/app/dashboard/custody/wallet-provider-mark", () => ({
  WalletProviderMark: () => <span>Provider mark</span>,
}));

vi.mock("@/app/dashboard/custody/connections/use-selected-project-name", () => ({
  useSelectedProjectName: () => "Acme Payments",
}));

import type {
  ConnectionsPageResult,
  CustodyConnectionListItem,
} from "@/app/dashboard/custody/connections/connections.data";
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
    isDefault: false,
    isRuntimeExecutionAllowed: true,
    defaultCustodyWalletId: null,
    ...overrides,
  };
}

function render({
  connections,
  canManageCustody = true,
}: {
  connections: CustodyConnectionListItem[];
  canManageCustody?: boolean;
}): string {
  const result: ConnectionsPageResult = {
    connections,
    pagination: { limit: 20, offset: 0, total: connections.length },
  };
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <CustodyConnectionsSection
        result={result}
        filters={{ page: 1 }}
        walletsByConnection={{}}
        walletsUnavailable={false}
        canManageCustody={canManageCustody}
        provider="privy"
      />
    </I18nProvider>
  );
}

describe("custody connections section", () => {
  it("warns that wallet-less requests fail while no active connection is default", () => {
    const html = render({ connections: [makeConnection({ id: "cconn_1", isDefault: false })] });

    expect(html).toContain("No default connection.");
    expect(html).toContain("fail until you make one of the active connections the default");
  });

  it("stays quiet once an active connection is the default", () => {
    const html = render({ connections: [makeConnection({ id: "cconn_1", isDefault: true })] });
    expect(html).not.toContain("No default connection.");
  });

  it("does not demand a default when there is no active connection to be one", () => {
    const html = render({
      connections: [makeConnection({ id: "cconn_1", status: "pending", activatedAt: null })],
    });
    expect(html).not.toContain("No default connection.");
  });

  it("explains a signing pause without implying anything was removed", () => {
    const html = render({
      connections: [
        makeConnection({ id: "cconn_1", isDefault: true, isRuntimeExecutionAllowed: false }),
      ],
    });

    expect(html).toContain("Signing through your own credentials is currently not allowed");
    expect(html).toContain("Nothing has been deleted.");
    // The connection itself is untouched and still listed as Active.
    expect(html).toContain("Active");
  });

  it("names the role a read-only viewer is missing, and offers them no actions", () => {
    const html = render({
      connections: [makeConnection({ id: "cconn_1", isDefault: true })],
      canManageCustody: false,
    });

    expect(html).toContain("custody admin");
    expect(html).toContain("Settings");
    expect(html).not.toContain("Add connection");
  });
});
