// @vitest-environment jsdom

import type { SdpEnvironment } from "@sdp/types/api-keys";
import type { EarnStrategy } from "@sdp/types/earn";
import type { SolanaCluster } from "@sdp/types/well-known-tokens";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnglishTestI18n } from "@/app/(session)/dashboard/[projectId]/markets/test-i18n";
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

/** Veda PRIME supports production; its devnet Test Vault remains fundable. */
const vedaPrimeStrategy: EarnStrategy = {
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

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({ sdpEnvironment: mocks.environment }),
}));

vi.mock("./earn-data", () => ({
  useEarnStrategies: (options?: { cluster?: SolanaCluster }) => {
    mocks.strategyClusters.push(options?.cluster);
    const mainnet = options?.cluster === "mainnet-beta";
    return {
      strategies: mainnet
        ? mocks.mainnetLoading
          ? undefined
          : [mainnetStrategy]
        : [liveStrategy, secondLiveStrategy, productionOnlyStrategy, vedaPrimeStrategy],
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
  return render(<EnglishTestI18n>{children}</EnglishTestI18n>);
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
        providerAccess={providerAccess}
        strategyId="earn_strategy_live"
      />
    );

    expect(screen.getByText("2. Set up the server code")).toBeTruthy();
    expect(screen.getByText("Kamino · Instant liquidity · 6.2% APY")).toBeTruthy();
    expect(screen.getAllByText("Kamino USDC Vault").length).toBeGreaterThan(0);

    // All five concerns stay visible as one radio group, while only the active code
    // slice renders. This keeps the whole flow findable without a wizard.
    const navigationNames = ["Client", "Deposits", "Portfolio", "Withdraw", "Queued"];
    const serverFlow = screen.getByRole("group", { name: "Server flow" });
    expect(within(serverFlow).getAllByRole("radio")).toHaveLength(5);
    expect(
      within(serverFlow).getByRole<HTMLInputElement>("radio", { name: "Client" }).checked
    ).toBe(true);
    expect(screen.getAllByText("embedded-yield.ts")).toHaveLength(1);
    // The key callout names the Earn grants the module needs and links to where
    // keys are made. A warning with no way to act on it is not guidance.
    expect(
      screen.getByText(
        /for this project with Earn Read, Execute and Manage\. Keep it on your server, never in the client\./
      )
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "API key" }).getAttribute("href")).toBe(
      "/dashboard/prj_test_sandbox/api-keys"
    );

    const snippets: string[] = [];
    for (const navigationName of navigationNames) {
      await user.click(within(serverFlow).getByRole("radio", { name: navigationName }));
      // Two code surfaces: the strategy ID and the one active code slice.
      const figures = screen.getAllByRole("figure");
      expect(figures).toHaveLength(2);
      snippets.push(figures[1]?.textContent ?? "");
    }
    const code = snippets.join("\n");
    expect(code).toContain("/v1/earn/deposit");
    expect(code).toContain("/v1/earn/withdraw");
    expect(code).toContain("/v1/earn/positions?");
    expect(code).toContain("/v1/operations?");
    expect(code).toContain("/submit");
    expect(code).toContain("/refresh");
    expect(code).toContain("/cancel");
    expect(code).toContain('const SDP_API_URL = "http://127.0.0.1:8787"');
    expect(code).toContain('const STRATEGY_ID = "earn_strategy_live"');
    expect(code).toContain('"Idempotency-Key": idempotencyKey');
    expect(code).toContain("source: { ownerAddress }");
    expect(code).toContain("signedTransaction?: string");
    expect(code).toContain("Show returned terms before asking the customer to sign");
    expect(code).toContain("Submission returns 202");
    expect(code).toContain("not a completed payout");
    expect(code).toContain("Pagination did not advance");
    expect(code).not.toMatch(/\/v1\/earn\/external-wallet\/|vault-deposits|deposit-transactions/);
  });

  it("copies the whole server module in one action, not just the active tab", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    renderWithEnglish(
      <EarnIntegrationGuide
        apiBaseUrl="http://127.0.0.1:8787"
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
    expect(copied).toContain("/v1/earn/deposit");
    expect(copied).toContain("/v1/earn/positions?");
    expect(copied).toContain("/v1/earn/withdraw");
    expect(copied).not.toContain("custodyWalletId");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("lists mainnet strategies in sandbox as plain options, with no network toggle", async () => {
    const user = userEvent.setup();
    renderWithEnglish(
      <EarnIntegrationGuide providerAccess={providerAccess} strategyId={mainnetStrategy.id} />
    );

    // Sandbox reads both shelves and shows them as one list.
    expect(mocks.strategyClusters).toContain("mainnet-beta");
    expect(screen.queryByLabelText("Strategy network")).toBeNull();

    // A mainnet pick names the network beside its code, which stays readable.
    expect(
      screen.getByText("This strategy runs on Mainnet, so this project can't fund it.")
    ).toBeTruthy();
    expect(screen.getByText(/STRATEGY_ID = "earn_strategy_mainnet"/)).toBeTruthy();

    await user.click(screen.getByRole("combobox", { name: "Choose a strategy" }));
    const mainnetRow = await screen.findByRole("option", { name: /Kamino JLP Vault/ });
    expect(mainnetRow.getAttribute("aria-disabled")).not.toBe("true");
    expect(mainnetRow.textContent).not.toMatch(/only|unavailable|plan/i);
  });

  it("keeps loading until the mainnet shelf answers, so a mainnet deep link never flashes as unknown", () => {
    mocks.mainnetLoading = true;
    const { container } = renderWithEnglish(
      <EarnIntegrationGuide providerAccess={providerAccess} strategyId={mainnetStrategy.id} />
    );

    expect(container.querySelector('[data-embedded-yield-loading="integrate"]')).toBeTruthy();
    expect(screen.queryByText("Strategy not found")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("names the network, not the plan, for a mainnet pick the organization is not entitled to", () => {
    renderWithEnglish(
      <EarnIntegrationGuide
        providerAccess={{ kamino: { entitled: false, configured: true, enabled: false } }}
        strategyId={mainnetStrategy.id}
      />
    );

    expect(screen.getByText(/runs on Mainnet/)).toBeTruthy();
    expect(screen.queryByText(/your plan/)).toBeNull();
  });

  it("lets the API derive enforceable floors from caller slippage", () => {
    const sections = buildEarnIntegrationSections({
      id: "earn_strategy_veda",
      depositSlippage: { quoteRequired: true, defaultToleranceBps: 10 },
      withdrawalSlippage: { quoteRequired: true, defaultToleranceBps: 10 },
    });
    const code = [sections.client, sections.deposit, sections.withdraw].join("\n");
    expect(code).toContain("slippageBps?: number");
    expect(code).not.toMatch(/floorForTolerance|minSharesOut|minAmountOut|vault-deposit-previews/);
  });

  it("defaults to the first available strategy without a separate selection step", () => {
    renderWithEnglish(<EarnIntegrationGuide providerAccess={providerAccess} />);

    expect(screen.getAllByText("Kamino USDC Vault").length).toBeGreaterThan(0);
    expect(screen.getByText("earn_strategy_live")).toBeTruthy();
    expect(screen.getByText(/STRATEGY_ID = "earn_strategy_live"/)).toBeTruthy();
  });

  it("keeps the strategy dropdown available when a deep-linked id no longer resolves", () => {
    renderWithEnglish(
      <EarnIntegrationGuide providerAccess={providerAccess} strategyId="earn_strategy_removed" />
    );

    expect(screen.getByText("Strategy not found")).toBeTruthy();
    expect(screen.getByText(/no longer listed/)).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Choose a strategy" })).toBeTruthy();
  });

  it("updates the strategy id and code in place when the dropdown changes", async () => {
    const user = userEvent.setup();
    renderWithEnglish(<EarnIntegrationGuide providerAccess={providerAccess} />);

    await user.click(screen.getByRole("combobox", { name: "Choose a strategy" }));
    await user.click(await screen.findByRole("option", { name: /Kamino Growth Vault.*8\.1%/ }));

    expect(screen.getByText("earn_strategy_growth")).toBeTruthy();
    expect(screen.getByText(/STRATEGY_ID = "earn_strategy_growth"/)).toBeTruthy();
    expect(screen.queryByText("earn_strategy_live")).toBeNull();
  });

  it("names production-only providers as such instead of the sandbox-era label", async () => {
    const user = userEvent.setup();
    renderWithEnglish(
      <EarnIntegrationGuide
        providerAccess={{
          ...providerAccess,
          jupiter_lend: { entitled: true, configured: true, enabled: true },
        }}
        strategyId={productionOnlyStrategy.id}
      />
    );

    // Deep link: the note says production-only, not sandbox-only.
    expect(screen.getByText("Jupiter Lend takes deposits in Production only.")).toBeTruthy();
    expect(screen.queryByText(/Sandbox only/)).toBeNull();

    // Dropdown: the row is a plain, selectable option.
    await user.click(screen.getByRole("combobox", { name: "Choose a strategy" }));
    const row = await screen.findByRole("option", { name: /Jupiter Lend USDT/ });
    expect(row.getAttribute("aria-disabled")).not.toBe("true");
    expect(row.textContent).not.toMatch(/only/);
  });

  it("opens a production deep link to Veda when its mainnet vault is live", () => {
    mocks.environment = "production";
    renderWithEnglish(
      <EarnIntegrationGuide
        providerAccess={{
          ...providerAccess,
          veda: { entitled: true, configured: true, enabled: true },
        }}
        strategyId={vedaPrimeStrategy.id}
      />
    );

    expect(
      screen.queryByText(/can't fund|deposits are off|your plan|takes deposits|isn't taking/)
    ).toBeNull();
    expect(screen.getByText("2. Set up the server code")).toBeTruthy();
    expect(screen.getByText(/STRATEGY_ID = "earn_strategy_veda"/)).toBeTruthy();
  });

  it("says a strategy is off the organization's plan while its code stays readable", () => {
    renderWithEnglish(
      <EarnIntegrationGuide
        providerAccess={{ kamino: { entitled: false, configured: true, enabled: false } }}
        strategyId="earn_strategy_live"
      />
    );

    expect(screen.getByText("Kamino isn't on your plan. Contact us to enable it.")).toBeTruthy();
    expect(screen.queryByText(/Setup required/)).toBeNull();
    expect(screen.getByText(/STRATEGY_ID = "earn_strategy_live"/)).toBeTruthy();
  });

  it("opens on the first listed strategy when the organization can fund none", () => {
    renderWithEnglish(
      <EarnIntegrationGuide
        providerAccess={{
          kamino: { entitled: false, configured: true, enabled: false },
          veda: { entitled: false, configured: true, enabled: false },
          jupiter_lend: { entitled: false, configured: true, enabled: false },
        }}
      />
    );

    expect(screen.getByText(/STRATEGY_ID = "earn_strategy_live"/)).toBeTruthy();
    expect(screen.getByText(/Kamino isn't on your plan/)).toBeTruthy();
    expect(screen.queryByText("No strategy selected")).toBeNull();
  });

  it("names missing provider credentials apart from the plan", () => {
    renderWithEnglish(
      <EarnIntegrationGuide
        providerAccess={{ kamino: { entitled: true, configured: false, enabled: false } }}
        strategyId="earn_strategy_live"
      />
    );

    expect(
      screen.getByText("Kamino credentials aren't configured here, so deposits are off.")
    ).toBeTruthy();
    expect(screen.queryByText(/your plan/)).toBeNull();
  });

  it("says provider access could not be checked when it was not read", () => {
    renderWithEnglish(
      <EarnIntegrationGuide providerAccess={null} strategyId="earn_strategy_live" />
    );

    expect(
      screen.getByText("Couldn't check provider access, so deposits are off. Reload to try again.")
    ).toBeTruthy();
    expect(screen.getByText(/STRATEGY_ID = "earn_strategy_live"/)).toBeTruthy();
  });
});
