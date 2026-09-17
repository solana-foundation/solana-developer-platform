// @vitest-environment jsdom

import type { EarnStrategy, SdpEnvironment, SolanaCluster } from "@sdp/types";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { EarnIntegrationGuide } from "./earn-integration-guide";
import {
  buildEarnIntegrationSections,
  buildEarnServerIntegration,
} from "./earn-integration-snippets";

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
  depositSlippage: null,
  withdrawalSlippage: null,
  hostCluster: "devnet",
  fundable: true,
  feeSponsored: false,
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

const secondLiveStrategy: EarnStrategy = {
  ...liveStrategy,
  id: "earn_strategy_growth",
  providerReference: "KvaultGrowth111111111111111111111111111111",
  name: "Kamino Growth Vault",
  currentApy: "0.081",
};

/** Jupiter deposits are production-only; its sandbox mirror is browse-only. */
const productionOnlyStrategy: EarnStrategy = {
  ...liveStrategy,
  id: "earn_strategy_jupiter",
  provider: "jupiter_lend",
  providerReference: "JupiterUSDT111111111111111111111111111111",
  name: "Jupiter Lend USDT",
  shareMint: "ShareJupiter111111111111111111111111111111",
  currentApy: "0.0378",
  depositSlippage: { quoteRequired: true, defaultToleranceBps: 10 },
  withdrawalSlippage: { quoteRequired: true, defaultToleranceBps: 10 },
};

/** Veda deposits stay sandbox-only until it names a production vault (PRO-1777). */
const sandboxOnlyStrategy: EarnStrategy = {
  ...liveStrategy,
  id: "earn_strategy_veda",
  provider: "veda",
  providerReference: "VedaVault1111111111111111111111111111111111",
  name: "Veda Treasury Fund",
  sourceKind: "rwa",
  shareMint: "ShareVeda1111111111111111111111111111111111",
  depositSlippage: { quoteRequired: true, defaultToleranceBps: 10 },
  withdrawalSlippage: { quoteRequired: true, defaultToleranceBps: 10 },
};

const mocks = vi.hoisted(() => ({
  environment: "sandbox" as SdpEnvironment,
  strategyClusters: [] as Array<SolanaCluster | undefined>,
  mainnetLoading: false,
}));

vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({ sdpEnvironment: mocks.environment }),
}));

vi.mock("./earn-program-data", () => ({
  useEarnStrategies: (options?: { cluster?: SolanaCluster }) => {
    mocks.strategyClusters.push(options?.cluster);
    const mainnet = options?.cluster === "mainnet-beta";
    return {
      strategies: mainnet
        ? mocks.mainnetLoading
          ? undefined
          : [mainnetStrategy]
        : [liveStrategy, secondLiveStrategy, productionOnlyStrategy, sandboxOnlyStrategy],
      error: undefined,
      isLoading: mainnet && mocks.mainnetLoading,
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
  mocks.strategyClusters.length = 0;
  mocks.mainnetLoading = false;
  vi.clearAllMocks();
  cleanup();
});

describe("EarnIntegrationGuide", () => {
  const providerAccess = {
    kamino: { entitled: true, configured: true, enabled: true },
  } as const;

  it("renders a compact reference guide with the real B2B2C contract", async () => {
    const user = userEvent.setup();
    renderWithEnglish(
      <EarnIntegrationGuide
        apiBaseUrl="http://127.0.0.1:8787"
        earnHref="/dashboard/markets/embedded-yield"
        providerAccess={providerAccess}
        strategyId="earn_strategy_live"
      />
    );

    expect(screen.getByText("2. Set up the server code")).toBeTruthy();
    expect(screen.getByText("Kamino · Instant liquidity · 6.2% APY")).toBeTruthy();
    expect(screen.getAllByText("Kamino USDC Vault").length).toBeGreaterThan(0);

    // All four concerns stay visible as navigation, while only the active code
    // slice renders. This keeps the whole flow findable without a wizard.
    const navigationNames = ["Client", "Deposits", "Portfolio", "Withdraw"];
    const serverFlow = screen.getByLabelText("Server flow");
    expect(within(serverFlow).getAllByRole("button")).toHaveLength(4);
    expect(
      within(serverFlow).getByRole("button", { name: "Client" }).getAttribute("aria-pressed")
    ).toBe("true");
    expect(screen.getAllByText("embedded-yield.ts")).toHaveLength(1);
    // The key callout says which key, says it covers Earn, and links to where it
    // is made. A warning with no way to act on it is not guidance.
    expect(
      screen.getByText(
        /for this project \(it includes earn:read and earn:write\)\. Keep it on your server, never in the client\./
      )
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Developer API key" }).getAttribute("href")).toBe(
      "/dashboard/api-keys"
    );

    // The snippet is the REAL B2B2C contract (PRO-1722): build the unsigned
    // transaction, the customer's wallet signs, submit the signed bytes. The
    // treasury route (vault-deposits + custodyWalletId) must not appear here —
    // a B2B2C partner cannot name a custody wallet.
    const snippets: string[] = [];
    for (const navigationName of navigationNames) {
      await user.click(within(serverFlow).getByRole("button", { name: navigationName }));
      // Two code surfaces: the strategy ID and the one active code slice.
      const figures = screen.getAllByRole("figure");
      expect(figures).toHaveLength(2);
      snippets.push(figures[1]?.textContent ?? "");
    }
    const code = snippets.join("\n");
    expect(code).toContain("/v1/earn/external-wallet/deposit-transactions");
    expect(code).toContain('const SDP_API_URL = "http://127.0.0.1:8787"');
    expect(code).not.toContain('const SDP_API_URL = "https://api.solana.com"');
    expect(code).toContain("/v1/earn/external-wallet/deposits");
    expect(code).toContain('"Idempotency-Key": idempotencyKey');
    expect(code).not.toContain("crypto.randomUUID()");
    expect(code).toContain('const STRATEGY_ID = "earn_strategy_live"');
    expect(code).toContain("/v1/earn/strategies?page=1&pageSize=100");
    expect(code).toContain("ownerAddress");
    // The preview helpers ship for every strategy, but a strategy with no
    // slippage contract must not compute or send a floor from one.
    expect(code).toContain("const minSharesOut = undefined");
    expect(code).toContain("const minAmountOut = undefined");
    expect(code).not.toContain("floorForTolerance(quote.sharesOut");
    expect(code).not.toContain("floorForTolerance(quote.assetsOut");
    expect(code).toContain("signedTransaction");
    expect(code).toContain("feePayer?: string");
    // The deposit body names the strategy by id only; the old client-side
    // strategy object and its source mint are gone from the copied module.
    expect(code).toContain("strategyId: STRATEGY_ID");
    expect(code).not.toContain("sourceTokenMint");
    expect(code).not.toContain("EMBEDDED_YIELD_STRATEGY");
    expect(code.match(/return data\.transaction;/g)).toHaveLength(2);
    expect(code).not.toContain("custodyWalletId");
    expect(code).not.toContain("vault-deposits");
    expect(code).not.toContain("requestId");
    // ... and the guide is the WHOLE loop (PRO-1772), not just the deposit:
    // poll the movement, read balance + earned, list activity, withdraw the
    // same two-call way money came in.
    expect(code).toContain("/v1/earn/external-wallet/movements/");
    expect(code).toContain("/v1/earn/external-wallet/movements?");
    expect(code).toContain("/v1/earn/external-wallet/earnings?");
    expect(code).toContain("/v1/earn/external-wallet/positions?");
    // The path-addressed owner shapes were retired for the query form; a
    // snippet regression here would hand partners a 404ing example.
    expect(code).not.toContain("/v1/earn/external-wallet/earnings/");
    expect(code).not.toContain("/v1/earn/external-wallet/positions/");
    expect(code).toContain("/v1/earn/external-wallet/withdrawal-transactions");
    expect(code).toContain("/v1/earn/external-wallet/withdrawals");
    expect(code).toContain("waitForEarnMovement");
    expect(code).toContain('movement.status === "finalized"');
    expect(code).not.toContain("Buffer.from");
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

  it("copies the whole server module in one action, not just the active tab", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    renderWithEnglish(
      <EarnIntegrationGuide
        apiBaseUrl="http://127.0.0.1:8787"
        earnHref="/dashboard/markets/embedded-yield"
        providerAccess={providerAccess}
        strategyId="earn_strategy_live"
      />
    );

    await user.click(screen.getByRole("button", { name: "Copy all code" }));

    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0]?.[0] as string;
    expect(copied).toBe(buildEarnServerIntegration(liveStrategy, "http://127.0.0.1:8787"));
    // Every section rides along even though only the Client tab is rendered.
    expect(copied).toContain('const SDP_API_URL = "http://127.0.0.1:8787"');
    expect(copied).toContain("/v1/earn/external-wallet/deposit-transactions");
    expect(copied).toContain("/v1/earn/external-wallet/earnings?");
    expect(copied).toContain("/v1/earn/external-wallet/withdrawals");
    expect(copied).not.toContain("custodyWalletId");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("lists mainnet strategies disabled in sandbox, with no network toggle", async () => {
    const user = userEvent.setup();
    renderWithEnglish(
      <EarnIntegrationGuide
        earnHref="/dashboard/markets/embedded-yield"
        providerAccess={providerAccess}
        strategyId={mainnetStrategy.id}
      />
    );

    // Sandbox reads both shelves and shows them as one list.
    expect(mocks.strategyClusters).toContain("mainnet-beta");
    expect(screen.queryByLabelText("Strategy network")).toBeNull();

    // A mainnet deep link is refused, named as a network mismatch, and never
    // rendered as code.
    expect(screen.getByText("Strategy deposits unavailable")).toBeTruthy();
    expect(screen.getByText(/different network from this project/)).toBeTruthy();
    expect(screen.queryByText(/STRATEGY_ID = "earn_strategy_mainnet"/)).toBeNull();

    await user.click(screen.getByRole("combobox", { name: "Select a strategy" }));
    const mainnetRow = await screen.findByRole("option", {
      name: /Kamino JLP Vault.*Mainnet only/,
    });
    expect(mainnetRow.getAttribute("aria-disabled")).toBe("true");
    expect(
      screen.getByRole("option", { name: /Kamino USDC Vault/ }).getAttribute("aria-disabled")
    ).not.toBe("true");
  });

  it("keeps loading until the mainnet shelf answers, so a mainnet deep link never flashes as unknown", () => {
    mocks.mainnetLoading = true;
    const { container } = renderWithEnglish(
      <EarnIntegrationGuide
        earnHref="/dashboard/markets/embedded-yield"
        providerAccess={providerAccess}
        strategyId={mainnetStrategy.id}
      />
    );

    expect(container.querySelector('[data-embedded-yield-loading="integrate"]')).toBeTruthy();
    expect(screen.queryByText("Strategy no longer available")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("does not let a mainnet deep link bypass the cluster check even with provider access", () => {
    renderWithEnglish(
      <EarnIntegrationGuide
        earnHref="/dashboard/markets/embedded-yield"
        providerAccess={{ kamino: { entitled: false, configured: true, enabled: false } }}
        strategyId={mainnetStrategy.id}
      />
    );

    expect(screen.getByText("Strategy deposits unavailable")).toBeTruthy();
    expect(screen.queryByText(/STRATEGY_ID = "earn_strategy_mainnet"/)).toBeNull();
  });

  it("generates quote-derived deposit and withdrawal floors for Veda", () => {
    // The snippet builder reads only the id and the two slippage contracts; the
    // provider no longer shapes the copied module.
    const sections = buildEarnIntegrationSections({
      id: "earn_strategy_veda",
      depositSlippage: { quoteRequired: true, defaultToleranceBps: 10 },
      withdrawalSlippage: { quoteRequired: true, defaultToleranceBps: 10 },
    });
    const code = [sections.client, sections.deposit, sections.withdraw].join("\n");

    expect(code).toContain("/v1/earn/vault-deposit-previews");
    expect(code).toContain("/v1/earn/external-wallet/withdrawal-previews");
    expect(code).toContain("floorForTolerance(quote.sharesOut");
    expect(code).toContain("floorForTolerance(quote.assetsOut");
    expect(code).toContain("minSharesOut");
    expect(code).toContain("minAmountOut");
    expect(code).toContain("slippageBps = 10");
  });

  it("defaults to the first available strategy without a separate selection step", () => {
    renderWithEnglish(
      <EarnIntegrationGuide
        earnHref="/dashboard/markets/embedded-yield"
        providerAccess={providerAccess}
      />
    );

    expect(screen.getAllByText("Kamino USDC Vault").length).toBeGreaterThan(0);
    expect(screen.getByText("earn_strategy_live")).toBeTruthy();
    expect(screen.getByText(/STRATEGY_ID = "earn_strategy_live"/)).toBeTruthy();
  });

  it("keeps the strategy dropdown available when a deep-linked id no longer resolves", () => {
    renderWithEnglish(
      <EarnIntegrationGuide
        earnHref="/dashboard/markets/embedded-yield"
        providerAccess={providerAccess}
        strategyId="earn_strategy_removed"
      />
    );

    expect(screen.getByText("Strategy no longer available")).toBeTruthy();
    expect(screen.getByText(/no longer in the live catalogue/)).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Select a strategy" })).toBeTruthy();
  });

  it("updates the strategy id and code in place when the dropdown changes", async () => {
    const user = userEvent.setup();
    renderWithEnglish(
      <EarnIntegrationGuide
        earnHref="/dashboard/markets/embedded-yield"
        providerAccess={providerAccess}
      />
    );

    await user.click(screen.getByRole("combobox", { name: "Select a strategy" }));
    await user.click(await screen.findByRole("option", { name: /Kamino Growth Vault.*8\.1%/ }));

    expect(screen.getByText("earn_strategy_growth")).toBeTruthy();
    expect(screen.getByText(/STRATEGY_ID = "earn_strategy_growth"/)).toBeTruthy();
    expect(screen.queryByText("earn_strategy_live")).toBeNull();
  });

  it("names production-only providers as such instead of the sandbox-era label", async () => {
    const user = userEvent.setup();
    renderWithEnglish(
      <EarnIntegrationGuide
        earnHref="/dashboard/markets/embedded-yield"
        providerAccess={{
          ...providerAccess,
          jupiter_lend: { entitled: true, configured: true, enabled: true },
        }}
        strategyId={productionOnlyStrategy.id}
      />
    );

    // Deep link: the explanation says production-only, not sandbox-only.
    expect(screen.getByText("Strategy deposits unavailable")).toBeTruthy();
    expect(screen.getByText(/Production projects only/)).toBeTruthy();
    expect(screen.queryByText(/Sandbox projects only/)).toBeNull();

    // Dropdown: the disabled row carries the same verdict.
    await user.click(screen.getByRole("combobox", { name: "Select a strategy" }));
    expect(
      await screen.findByRole("option", { name: /Jupiter Lend USDT.*Production only/ })
    ).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Jupiter Lend USDT.*Sandbox only/ })).toBeNull();
  });

  it("refuses a deep link when the selected environment cannot fund the strategy", () => {
    mocks.environment = "production";
    renderWithEnglish(
      <EarnIntegrationGuide
        earnHref="/dashboard/markets/embedded-yield"
        providerAccess={{
          ...providerAccess,
          veda: { entitled: true, configured: true, enabled: true },
        }}
        strategyId={sandboxOnlyStrategy.id}
      />
    );

    expect(screen.getByText("Strategy deposits unavailable")).toBeTruthy();
    expect(screen.getByText(/Sandbox projects only/)).toBeTruthy();
    expect(screen.queryByText("2. Set up the server code")).toBeNull();
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
