// @vitest-environment jsdom

import type { EarnStrategy, SdpEnvironment, SolanaCluster } from "@sdp/types";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { EarnIntegrationGuide } from "./earn-integration-guide";

const liveStrategy: EarnStrategy = {
  id: "earn_strategy_live",
  provider: "kamino",
  providerReference: "Kvault11111111111111111111111111111111111",
  name: "Kamino USDC Vault",
  sourceKind: "defi",
  depositMints: ["So11111111111111111111111111111111111111112"],
  shareMint: "Share1111111111111111111111111111111111111",
  apyType: "variable",
  currentApy: "0.062",
  liquidityTerm: "instant",
  status: "active",
  hostCluster: "devnet",
  fundable: true,
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:00.000Z",
};

const mainnetStrategy: EarnStrategy = {
  ...liveStrategy,
  id: "earn_strategy_mainnet",
  providerReference: "KvaultMainnet111111111111111111111111111111",
  name: "Kamino JLP Vault",
  shareMint: "ShareMainnet111111111111111111111111111111",
  hostCluster: "mainnet-beta",
  fundable: false,
};

const mocks = vi.hoisted(() => ({
  environment: "sandbox" as SdpEnvironment,
  mainnetFundable: false,
  strategyClusters: [] as Array<SolanaCluster | undefined>,
}));

vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({ sdpEnvironment: mocks.environment }),
}));

vi.mock("./earn-program-data", () => ({
  useEarnStrategies: (options?: { cluster?: SolanaCluster }) => {
    mocks.strategyClusters.push(options?.cluster);
    return {
      strategies:
        options?.cluster === "mainnet-beta"
          ? [{ ...mainnetStrategy, fundable: mocks.mainnetFundable }]
          : [liveStrategy],
      error: undefined,
      isLoading: false,
    };
  },
}));

vi.mock("@/components/ui/code-block", () => ({
  CodeBlock: ({ code, title }: { code: string; title?: ReactNode }) => (
    <figure>
      <figcaption>{title}</figcaption>
      <pre>{code}</pre>
    </figure>
  ),
}));

function renderWithEnglish(children: ReactNode) {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      {children}
    </I18nProvider>
  );
}

afterEach(() => {
  mocks.environment = "sandbox";
  mocks.mainnetFundable = false;
  mocks.strategyClusters.length = 0;
  vi.clearAllMocks();
  cleanup();
});

describe("EarnIntegrationGuide", () => {
  const providerAccess = {
    kamino: { entitled: true, configured: true, enabled: true },
  } as const;

  it("renders a compact step-by-step guide with the real B2B2C contract", async () => {
    const user = userEvent.setup();
    renderWithEnglish(
      <EarnIntegrationGuide
        earnHref="/dashboard/markets/embedded-yield"
        providerAccess={providerAccess}
        strategyId="earn_strategy_live"
      />
    );

    expect(screen.getByText("Integrate Embedded Yield")).toBeTruthy();
    expect(screen.getAllByText("Kamino USDC Vault").length).toBeGreaterThan(0);

    // All four steps stay visible as navigation, while only the active code
    // slice renders. This keeps the whole flow findable without a long page.
    const navigationNames = ["Client", "Deposits", "Portfolio", "Withdraw"];
    const serverFlow = screen.getByLabelText("Server flow");
    expect(within(serverFlow).getAllByRole("button")).toHaveLength(4);
    expect(
      within(serverFlow).getByRole("button", { name: "Client" }).getAttribute("aria-pressed")
    ).toBe("true");
    expect(screen.getAllByText("server/embedded-yield.ts")).toHaveLength(1);
    expect(screen.getByText("Keep SDP_API_KEY on your server, never in the client.")).toBeTruthy();

    // The snippet is the REAL B2B2C contract (PRO-1722): build the unsigned
    // transaction, the customer's wallet signs, submit the signed bytes. The
    // treasury route (vault-deposits + custodyWalletId) must not appear here —
    // a B2B2C partner cannot name a custody wallet.
    const snippets: string[] = [];
    for (const navigationName of navigationNames) {
      await user.click(within(serverFlow).getByRole("button", { name: navigationName }));
      expect(screen.getAllByRole("figure")).toHaveLength(1);
      snippets.push(screen.getByRole("figure").textContent ?? "");
    }
    const code = snippets.join("\n");
    expect(code).toContain("/v1/earn/external-wallet/deposit-transactions");
    expect(code).toContain("/v1/earn/external-wallet/deposits");
    expect(code).toContain('"Idempotency-Key": idempotencyKey');
    expect(code).not.toContain("crypto.randomUUID()");
    expect(code).toContain('strategyId: "earn_strategy_live"');
    expect(code).toContain("ownerAddress");
    expect(code).toContain("minSharesOut: string");
    expect(code).toContain("minSharesOut,");
    expect(code).toContain("signedTransaction");
    expect(code).not.toContain("custodyWalletId");
    expect(code).not.toContain("vault-deposits");
    expect(code).not.toContain("requestId");
    // ... and the guide is the WHOLE loop (PRO-1772), not just the deposit:
    // poll the movement, read balance + earned, list activity, withdraw the
    // same two-call way money came in.
    expect(code).toContain("/v1/earn/external-wallet/movements/");
    expect(code).toContain("/v1/earn/external-wallet/movements?");
    expect(code).toContain("/v1/earn/external-wallet/earnings/");
    expect(code).toContain("/v1/earn/external-wallet/positions/");
    expect(code).toContain("/v1/earn/external-wallet/withdrawal-transactions");
    expect(code).toContain("/v1/earn/external-wallet/withdrawals");
    expect(code).toContain("earnedUnavailableReason");
    // A non-JSON error body (gateway 502 HTML) must still throw with the
    // status, not a bare SyntaxError, in the code partners copy-paste.
    expect(code).toContain("response.status");
    // The positions helper pages to completion — a short first page must not
    // hide withdrawable holdings from the copied withdraw flow — and fails
    // loudly on a cursor that does not advance rather than looping.
    expect(code).toContain("if (!data.hasMore) return positions;");
    expect(code).toContain("cursor did not advance");
  });

  it("renders a mainnet vault as a sandbox preview with an explicit warning", async () => {
    const user = userEvent.setup();
    renderWithEnglish(
      <EarnIntegrationGuide
        configureHref="/dashboard/markets/embedded-yield/configure"
        earnHref="/dashboard/markets/embedded-yield"
        providerAccess={providerAccess}
        strategyCluster="mainnet-beta"
        strategyId={mainnetStrategy.id}
      />
    );

    expect(mocks.strategyClusters).toContain("mainnet-beta");
    expect(screen.getAllByText("Kamino JLP Vault").length).toBeGreaterThan(0);
    expect(screen.getByText("Mainnet vault preview")).toBeTruthy();
    expect(screen.getByText(/Production project is required/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Deposits" }));
    expect(screen.getByText(/strategyId: "earn_strategy_mainnet"/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Change strategy" }).getAttribute("href")).toBe(
      "/dashboard/markets/embedded-yield/configure?cluster=mainnet-beta"
    );
  });

  it("does not let a mainnet deep link bypass provider access", () => {
    mocks.mainnetFundable = true;
    renderWithEnglish(
      <EarnIntegrationGuide
        configureHref="/dashboard/markets/embedded-yield/configure"
        earnHref="/dashboard/markets/embedded-yield"
        providerAccess={{ kamino: { entitled: false, configured: true, enabled: false } }}
        strategyCluster="mainnet-beta"
        strategyId={mainnetStrategy.id}
      />
    );

    expect(screen.getByText("Strategy deposits unavailable")).toBeTruthy();
    expect(screen.getByText(/provider is not enabled/)).toBeTruthy();
    expect(screen.queryByText("Mainnet vault preview")).toBeNull();
  });

  it("asks for a strategy when none is selected", () => {
    renderWithEnglish(
      <EarnIntegrationGuide
        earnHref="/dashboard/markets/embedded-yield"
        providerAccess={providerAccess}
      />
    );

    expect(screen.getByText("Choose a strategy first")).toBeTruthy();
    expect(screen.getByText(/select a live strategy/)).toBeTruthy();
  });

  it("offers a recovery route when the strategy id no longer resolves", () => {
    renderWithEnglish(
      <EarnIntegrationGuide
        earnHref="/dashboard/markets/embedded-yield"
        providerAccess={providerAccess}
        strategyId="earn_strategy_removed"
      />
    );

    expect(screen.getByText("Strategy no longer available")).toBeTruthy();
    expect(screen.getByText(/no longer in the live catalogue/)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Return to Embedded Yield" }).getAttribute("href")
    ).toBe("/dashboard/markets/embedded-yield");
  });

  it("refuses a deep link when the selected environment cannot fund the strategy", () => {
    mocks.environment = "production";
    renderWithEnglish(
      <EarnIntegrationGuide
        earnHref="/dashboard/markets/embedded-yield"
        providerAccess={providerAccess}
        strategyId="earn_strategy_live"
      />
    );

    expect(screen.getByText("Strategy deposits unavailable")).toBeTruthy();
    expect(screen.getByText(/sandbox-only/)).toBeTruthy();
    expect(screen.queryByText("1 · Set up the server client")).toBeNull();
  });

  it("names provider setup as the reason an otherwise live strategy cannot be integrated", () => {
    renderWithEnglish(
      <EarnIntegrationGuide
        earnHref="/dashboard/markets/embedded-yield"
        providerAccess={{ kamino: { entitled: true, configured: false, enabled: false } }}
        strategyId="earn_strategy_live"
      />
    );

    expect(screen.getByText("Strategy deposits unavailable")).toBeTruthy();
    expect(screen.getByText(/provider is not enabled/)).toBeTruthy();
  });
});
