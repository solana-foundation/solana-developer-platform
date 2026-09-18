import type { CustodyWalletSummary } from "@sdp/types";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/dashboard/wallets/connections",
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@/app/dashboard/custody/wallet-address-copy-button", () => ({
  WalletAddressCopyButton: () => null,
}));

vi.mock("@/app/dashboard/custody/wallet-provider-mark", () => ({
  WalletProviderMark: () => <span>Provider mark</span>,
}));

import {
  type ConnectionsPageResult,
  type ConnectionsProjectSummary,
  type CustodyConnectionListItem,
  summarizeProviderConnections,
} from "./connections.data";
import { ConnectionsList } from "./connections-list";

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
    isDefault: false,
    isRuntimeExecutionAllowed: true,
    defaultCustodyWalletId: `wallet-${overrides.id}`,
    ...overrides,
  };
}

function makeResult(
  connections: CustodyConnectionListItem[],
  total = connections.length,
  offset = 0
): ConnectionsPageResult {
  return { connections, pagination: { limit: 20, offset, total } };
}

function renderList({
  result,
  page = 1,
  // The project-level summary the section computes; defaults to the rows on
  // screen, which is the single-page case.
  summary = summarizeProviderConnections({ connections: result.connections, complete: true }),
  walletsByConnection = {},
  walletsUnavailable = false,
  canManageCustody = true,
  emptyStateAction,
}: {
  result: ConnectionsPageResult;
  page?: number;
  summary?: ConnectionsProjectSummary;
  walletsByConnection?: Record<string, CustodyWalletSummary[]>;
  walletsUnavailable?: boolean;
  canManageCustody?: boolean;
  emptyStateAction?: React.ReactNode;
}): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <ConnectionsList
        result={result}
        filters={{ page }}
        summary={summary}
        walletsByConnection={walletsByConnection}
        walletsUnavailable={walletsUnavailable}
        canManageCustody={canManageCustody}
        provider="privy"
        projectName="Acme Payments"
        emptyStateAction={emptyStateAction}
      />
    </I18nProvider>
  );
}

const connectionWallet: CustodyWalletSummary = {
  id: "wallet-row-1",
  custodyConnectionId: "conn-active",
  provider: "privy",
  isRuntimeExecutionAllowed: true,
  walletId: "wallet-byok-1",
  publicKey: "ByokPublicKey11111111111111111111111111111",
  label: "BYOK Treasury",
  purpose: "transfer",
  status: "active",
  createdAt: "2026-08-10T09:05:00.000Z",
};

describe("connections list", () => {
  it("renders one row per exact connection without collapsing duplicate labels", () => {
    const html = renderList({
      result: makeResult([
        makeConnection({ id: "conn-active", label: "Shared Privy app" }),
        makeConnection({
          id: "conn-second",
          label: "Shared Privy app",
          status: "pending",
          activatedAt: null,
        }),
      ]),
    });

    expect(html.match(/data-connection-id=/g)).toHaveLength(2);
    expect(html).toContain('data-connection-id="conn-active"');
    expect(html).toContain('data-connection-id="conn-second"');
    // Two connections can legitimately share a label — it belongs to the
    // credential, not the connection — so each row has to address its own id
    // rather than rely on the name to tell them apart.
    expect(html).toContain("/dashboard/integrations/privy/connections/conn-active");
    expect(html).toContain("/dashboard/integrations/privy/connections/conn-second");
    expect(html).toContain("Active");
    expect(html).toContain("Pending");
  });

  it("shows the joined wallet for a connection and a failure hint on failed rows", () => {
    const html = renderList({
      result: makeResult([
        makeConnection({ id: "conn-active" }),
        makeConnection({
          id: "conn-failed",
          status: "failed",
          activatedAt: null,
          lastCheck: {
            status: "failed",
            at: "2026-08-11T09:00:00.000Z",
            failureCode: "invalid_credentials",
          },
        }),
      ]),
      walletsByConnection: { "conn-active": [connectionWallet] },
    });

    expect(html).toContain("BYOK Treasury");
    expect(html).toContain("Credentials were rejected");
  });

  it("falls back to the pending wallet label before any wallet exists", () => {
    const html = renderList({
      result: makeResult([
        makeConnection({
          id: "conn-pending",
          status: "pending",
          activatedAt: null,
          lastCheck: null,
          pendingWalletLabel: "Treasury-to-be",
        }),
      ]),
    });

    expect(html).toContain("Treasury-to-be");
    expect(html).toContain("Wallet pending activation");
  });

  it("renders the empty state for an empty slice even when a stale total disagrees", () => {
    const html = renderList({ result: makeResult([], 20) });

    expect(html).toContain("No connections in Acme Payments yet");
    expect(html).not.toContain("data-connection-id");
  });

  it("renders whatever empty-state action it is handed, and nothing when handed none", () => {
    const emptyResult = makeResult([]);

    // Gating the action on the custody-admin role is the section's job now —
    // the list only places what it is given.
    const withAction = renderList({
      result: emptyResult,
      emptyStateAction: <button type="button">Add connection</button>,
    });
    expect(withAction).toContain("No connections in Acme Payments yet");
    expect(withAction).toContain("Add connection");

    const withoutAction = renderList({ result: emptyResult });
    expect(withoutAction).toContain("No connections in Acme Payments yet");
    expect(withoutAction).not.toContain("Add connection");
  });

  it("paginates only past one page and marks degraded wallet reads", () => {
    const singlePage = renderList({
      result: makeResult([makeConnection({ id: "conn-active" })]),
      walletsUnavailable: true,
    });
    expect(singlePage).not.toContain("Page 1 of");
    expect(singlePage).toContain("Wallets unavailable right now");

    const multiPage = renderList({
      result: makeResult([makeConnection({ id: "conn-active" })], 45),
    });
    expect(multiPage).toContain("Page 1 of 3");
  });
});
