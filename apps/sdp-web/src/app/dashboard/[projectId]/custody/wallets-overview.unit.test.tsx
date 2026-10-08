import type { CustodyWalletSummary } from "@sdp/types";
import type { ComponentProps, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { availableCustodyProviders } from "@/lib/provider-availability";
import { SANDBOX_PROJECT } from "@/test/projects";
import { projectProviderAvailability } from "@/test/provider-availability";

const urlState = vi.hoisted(() => ({ query: "" }));

vi.mock("@/lib/dashboard-url-state", () => ({
  useDashboardUrlState: () => ({
    searchParams: new URLSearchParams(urlState.query ? { query: urlState.query } : undefined),
    replaceSearchParams: vi.fn(),
  }),
}));

vi.mock("@/app/dashboard/[projectId]/custody/wallet-card-balance-value", () => ({
  WalletCardBalanceValue: () => <span>Balance</span>,
}));

vi.mock("@/app/dashboard/[projectId]/custody/wallet-label-inline-editor", () => ({
  WalletLabelInlineEditor: ({ label }: { label: string | null }) => <span>{label}</span>,
}));

vi.mock("@/app/dashboard/[projectId]/custody/wallet-address-copy-button", () => ({
  WalletAddressCopyButton: () => null,
  WalletMetadataCopyButton: () => null,
  WalletMetaValue: ({ displayValue }: { displayValue: string }) => <span>{displayValue}</span>,
}));

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
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
    custodyConfigId: "custody-config-1",
    provider: "privy",
    isRuntimeExecutionAllowed: true,
    walletId: "wallet-treasury",
    publicKey: "TreasuryPublicKey1111111111111111111111111",
    label: "Operations Treasury",
    purpose: "transfer",
    status: "active",
    createdAt: "2026-07-18T12:00:00.000Z",
  },
  {
    id: "wallet-row-2",
    custodyConfigId: "custody-config-2",
    provider: "coinbase_cdp",
    isRuntimeExecutionAllowed: true,
    walletId: "wallet-issuer",
    publicKey: "IssuerPublicKey222222222222222222222222222",
    label: "Primary Issuer",
    purpose: "mint_authority",
    status: "active",
    createdAt: "2026-07-18T12:00:00.000Z",
  },
];

const CUSTODY_AVAILABILITY = availableCustodyProviders(
  projectProviderAvailability({
    project: SANDBOX_PROJECT,
    custody: [
      { provider: "privy", modes: ["managed", "byok"] },
      { provider: "coinbase_cdp", modes: ["managed"] },
    ],
    compliance: [],
    ramps: [],
    earn: [],
  })
);

function renderOverview(
  query: string,
  overrides: Partial<ComponentProps<typeof WalletsOverview>>
): string {
  urlState.query = query;
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <WalletsOverview
        canManageCustody
        connectedProviders={[]}
        custodyAvailability={CUSTODY_AVAILABILITY}
        configsError={null}
        wallets={wallets}
        walletsError={null}
        onCreateWallet={() => undefined}
        {...overrides}
      />
    </I18nProvider>
  );
}

describe("wallets overview search", () => {
  it("shows only the providers the project can use when it has no wallets", () => {
    const html = renderOverview("", { wallets: [] });
    expect(html).toContain("Privy");
    expect(html).toContain("Coinbase CDP");
    for (const provider of ["Turnkey", "Fireblocks", "DFNS", "Anchorage", "Utila"]) {
      expect(html).not.toContain(provider);
    }
    expect(html).not.toContain("<h3");
    expect(html.match(/<section /g)).toHaveLength(1);
    expect(html.match(/data-provider-selection-card="true"/g)).toHaveLength(2);
    expect(html.match(/data-provider-selectable="true"/g)).toHaveLength(2);
  });

  it("explains provider setup and offers no creation when the project can use no provider", () => {
    const emptyProject = renderOverview("", { wallets: [], custodyAvailability: [] });
    expect(emptyProject).toContain(
      "Wallet creation is available after a custody provider is enabled for this organization."
    );
    expect(emptyProject).not.toContain("data-provider-selection-card");

    const withWallets = renderOverview("", { custodyAvailability: [] });
    expect(withWallets.match(/data-wallet-card=/g)).toHaveLength(2);
    expect(withWallets).not.toContain('data-wallet-create-tile="true"');
  });

  it("keeps the provider catalog out of the existing wallet list", () => {
    const html = renderOverview("", {});
    expect(html).not.toContain("data-provider-selection-card");
    expect(html).toContain('data-wallet-card="wallet-treasury"');
  });

  it("shows the catalog without creation actions for read-only members", () => {
    const html = renderOverview("", { wallets: [], canManageCustody: false });
    expect(html).toContain("Privy");
    expect(html).toContain("Coinbase CDP");
    expect(html).not.toContain('data-provider-selectable="true"');
  });

  it("renders one responsive toolbar and only matching wallet cards", () => {
    const html = renderOverview("treasury", {});

    expect(html.match(/data-wallet-search-toolbar="true"/g)).toHaveLength(1);
    expect(html).toContain("flex-col gap-3 sm:flex-row");
    expect(html).toContain('value="treasury"');
    expect(html).toContain('data-wallet-card="wallet-treasury"');
    expect(html).not.toContain('data-wallet-card="wallet-issuer"');
    expect(html).not.toContain('data-wallet-create-tile="true"');
    expect(html).toContain("Showing 1 of 2 wallets");
  });

  it("shows an actionable empty state without confusing it with an empty project", () => {
    const html = renderOverview("does-not-exist", {});

    expect(html).toContain("No wallets match this search");
    expect(html).toContain("Clear search");
    expect(html).not.toContain("Create your first wallet");
    expect(html).not.toContain("data-wallet-card=");
  });

  it("restores every wallet and the create tile when the query is reset", () => {
    const html = renderOverview("", {});

    expect(html.match(/data-wallet-card=/g)).toHaveLength(2);
    expect(html.match(/data-wallet-create-tile="true"/g)).toHaveLength(1);
    expect(html).not.toContain("walletSearchResults");
  });
});

describe("wallets overview signing restriction", () => {
  it("badges a wallet whose signing is disabled, and only that wallet", () => {
    expect(renderOverview("", {})).not.toContain("Restricted");
    const html = renderOverview("", {
      wallets: [{ ...wallets[0], isRuntimeExecutionAllowed: false }, wallets[1]],
    });
    expect(html.match(/Restricted/g)).toHaveLength(1);
  });
});
