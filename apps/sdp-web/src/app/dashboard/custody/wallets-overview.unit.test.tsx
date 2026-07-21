import type { CustodyWalletSummary } from "@sdp/types";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";

const urlState = vi.hoisted(() => ({ query: "" }));

vi.mock("@/lib/dashboard-url-state", () => ({
  useDashboardUrlState: () => ({
    searchParams: new URLSearchParams(urlState.query ? { query: urlState.query } : undefined),
    replaceSearchParams: vi.fn(),
  }),
}));

vi.mock("@/app/dashboard/custody/wallet-card-balance-value", () => ({
  WalletCardBalanceValue: () => <span>Balance</span>,
}));

vi.mock("@/app/dashboard/custody/wallet-label-inline-editor", () => ({
  WalletLabelInlineEditor: ({ label }: { label: string | null }) => <span>{label}</span>,
}));

vi.mock("@/app/dashboard/custody/wallet-address-copy-button", () => ({
  WalletAddressCopyButton: () => null,
  WalletMetadataCopyButton: () => null,
}));

vi.mock("@/components/dashboard-navigation-link", () => ({
  DashboardNavigationLink: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("./wallet-provider-mark", () => ({
  WalletProviderMark: () => <span>Provider</span>,
}));

import { WalletsOverview } from "./wallets-overview";

const wallets: CustodyWalletSummary[] = [
  {
    id: "wallet-row-1",
    provider: "privy",
    walletId: "wallet-treasury",
    publicKey: "TreasuryPublicKey1111111111111111111111111",
    label: "Operations Treasury",
    purpose: "transfer",
    status: "active",
    createdAt: "2026-07-18T12:00:00.000Z",
  },
  {
    id: "wallet-row-2",
    provider: "coinbase_cdp",
    walletId: "wallet-issuer",
    publicKey: "IssuerPublicKey222222222222222222222222222",
    label: "Primary Issuer",
    purpose: "mint_authority",
    status: "active",
    createdAt: "2026-07-18T12:00:00.000Z",
  },
];

function renderOverview(query: string): string {
  urlState.query = query;
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <WalletsOverview
        canManageCustody
        enabledProviders={["privy", "coinbase_cdp"]}
        configsError={null}
        wallets={wallets}
        walletsError={null}
        onCreateWallet={() => undefined}
      />
    </I18nProvider>
  );
}

describe("wallets overview search", () => {
  it("renders one responsive toolbar and only matching wallet cards", () => {
    const html = renderOverview("treasury");

    expect(html.match(/data-wallet-search-toolbar="true"/g)).toHaveLength(1);
    expect(html).toContain("flex-col gap-3 sm:flex-row");
    expect(html).toContain('value="treasury"');
    expect(html).toContain('data-wallet-card="wallet-treasury"');
    expect(html).not.toContain('data-wallet-card="wallet-issuer"');
    expect(html).not.toContain('data-wallet-create-tile="true"');
    expect(html).toContain("Showing 1 of 2 wallets");
  });

  it("shows an actionable empty state without confusing it with an empty project", () => {
    const html = renderOverview("does-not-exist");

    expect(html).toContain("No wallets match this search");
    expect(html).toContain("Clear search");
    expect(html).not.toContain("Create your first wallet");
    expect(html).not.toContain("data-wallet-card=");
  });

  it("restores every wallet and the create tile when the query is reset", () => {
    const html = renderOverview("");

    expect(html.match(/data-wallet-card=/g)).toHaveLength(2);
    expect(html.match(/data-wallet-create-tile="true"/g)).toHaveLength(1);
    expect(html).not.toContain("walletSearchResults");
  });
});
