// @vitest-environment jsdom

import type {
  EarnButtonConfiguration,
  EarnStrategy,
  SdpEnvironment,
  SolanaCluster,
} from "@sdp/types";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { EarnButtonBuilder } from "./earn-button-builder";

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
  saveEarnButtonConfiguration: vi.fn(),
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

vi.mock("./earn-button-configuration-data", () => ({
  saveEarnButtonConfiguration: mocks.saveEarnButtonConfiguration,
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

describe("EarnButtonBuilder", () => {
  const providerAccess = {
    kamino: { entitled: true, configured: true, enabled: true },
  } as const;
  const noConfiguration = { kind: "ready", configuration: null } as const;
  const savedConfiguration: EarnButtonConfiguration = {
    id: "earn_button_config_saved",
    strategyId: liveStrategy.id,
    style: "light",
    accentColor: "#14F195",
    publicToken: "PublicEarnButtonToken123",
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  };

  it("edits, previews, and saves a live style while keeping the server contract explicit", async () => {
    const user = userEvent.setup();
    mocks.saveEarnButtonConfiguration.mockResolvedValue({
      ok: true,
      status: 200,
      data: { ...savedConfiguration, style: "accent", accentColor: "#9945FF" },
    });
    renderWithEnglish(
      <EarnButtonBuilder
        configurationLoad={noConfiguration}
        earnHref="/dashboard/markets/embedded-yield"
        projectId="project_original"
        providerAccess={providerAccess}
        strategyId="earn_strategy_live"
      />
    );

    const iosPreview = screen.getByRole("figure", { name: "iOS preview" });
    expect(within(iosPreview).getByText("Kamino USDC Vault")).toBeTruthy();
    expect(screen.queryByRole("figure", { name: "Web browser preview" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Web" }));
    const webPreview = screen.getByRole("figure", { name: "Web browser preview" });
    expect(within(webPreview).getByText("6.2% variable APY")).toBeTruthy();
    expect(screen.queryByRole("figure", { name: "iOS preview" })).toBeNull();

    const accentRadio = screen.getByRole("radio", { name: /^Accent/ }) as HTMLInputElement;
    expect(accentRadio.disabled).toBe(false);
    expect(accentRadio.checked).toBe(false);
    await user.click(accentRadio);
    expect(accentRadio.checked).toBe(true);
    await user.click(screen.getByRole("button", { name: "Purple" }));
    expect(
      (within(webPreview).getByText("Deposit & earn") as HTMLElement).style.backgroundColor
    ).toBe("rgb(153, 69, 255)");
    await user.click(screen.getByRole("button", { name: "iOS" }));
    expect(
      within(screen.getByRole("figure", { name: "iOS preview" })).getByText("Deposit & earn")
        .className
    ).toContain("shadow-sm");
    expect(
      (
        within(screen.getByRole("figure", { name: "iOS preview" })).getByText(
          "Deposit & earn"
        ) as HTMLElement
      ).style.backgroundColor
    ).toBe("rgb(153, 69, 255)");

    await user.click(screen.getByRole("button", { name: "Save configuration" }));
    expect(mocks.saveEarnButtonConfiguration).toHaveBeenCalledWith({
      projectId: "project_original",
      strategyId: liveStrategy.id,
      style: "accent",
      accentColor: "#9945FF",
    });
    expect(
      await screen.findByText("Configuration saved. The handoff link is current.")
    ).toBeTruthy();
    expect(
      screen.getByRole("link", {
        name: /embedded-yield\/integrate\/PublicEarnButtonToken123/,
      })
    ).toBeTruthy();

    // The snippet is the REAL B2B2C contract (PRO-1722): build the unsigned
    // transaction, the customer's wallet signs, submit the signed bytes. The
    // treasury route (vault-deposits + custodyWalletId) must not reappear
    // here — a B2B2C partner cannot name a custody wallet.
    const code =
      screen.getByText(/v1\/earn\/external-wallet\/deposit-transactions/).textContent ?? "";
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
    expect(code).not.toContain("developers.solana.com/earn/buttons");
    // ... and since PRO-1772 the snippet is the WHOLE loop, not just the
    // deposit: poll the movement, read balance + earned, list activity,
    // withdraw the same two-call way money came in.
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

    // The customer preview carries the Deel-shape savings card: balance,
    // total earned, deposit + withdraw, activity.
    expect(screen.getByText("Savings balance")).toBeTruthy();
    expect(screen.getByText("+$14.18 total earned")).toBeTruthy();
    expect(screen.getByText("Withdraw")).toBeTruthy();
    expect(screen.getByText("Recent activity")).toBeTruthy();
    expect(screen.getByText("Withdrawal")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Done" }).getAttribute("href")).toBe(
      "/dashboard/markets/embedded-yield"
    );
  });

  it("keeps an edit made while a save is in flight instead of reporting it saved", async () => {
    const user = userEvent.setup();
    let resolveSave: (value: unknown) => void = () => {};
    mocks.saveEarnButtonConfiguration.mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve;
      })
    );
    renderWithEnglish(
      <EarnButtonBuilder
        configurationLoad={{
          kind: "ready",
          configuration: { ...savedConfiguration, style: "accent", accentColor: "#9945FF" },
        }}
        earnHref="/dashboard/markets/embedded-yield"
        projectId="project_original"
        providerAccess={providerAccess}
      />
    );

    await user.click(screen.getByRole("button", { name: "Blue" }));
    await user.click(screen.getByRole("button", { name: "Save configuration" }));
    // The PUT is in flight; a newer edit lands before it resolves.
    await user.click(screen.getByRole("button", { name: "Coral" }));
    resolveSave({
      ok: true,
      status: 200,
      data: { ...savedConfiguration, style: "accent", accentColor: "#4C6FFF" },
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save configuration" })).toHaveProperty(
        "disabled",
        false
      );
    });
    // The footer must not claim the Coral selection was saved, and the local
    // selection must survive the response.
    expect(screen.queryByText("Configuration saved. The handoff link is current.")).toBeNull();
    expect(screen.getByRole("button", { name: "Coral" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("selects the matching preset for a saved lowercase accent color", () => {
    renderWithEnglish(
      <EarnButtonBuilder
        configurationLoad={{
          kind: "ready",
          configuration: { ...savedConfiguration, style: "accent", accentColor: "#9945ff" },
        }}
        earnHref="/dashboard/markets/embedded-yield"
        projectId="project_original"
        providerAccess={providerAccess}
      />
    );

    expect(screen.getByRole("button", { name: "Purple" }).getAttribute("aria-pressed")).toBe(
      "true"
    );
    expect(screen.getByRole("button", { name: "Save configuration" })).toHaveProperty(
      "disabled",
      true
    );
  });

  it("still renders the selected strategy when the saved configuration failed to load", () => {
    renderWithEnglish(
      <EarnButtonBuilder
        configurationLoad={{ kind: "error" }}
        earnHref="/dashboard/markets/embedded-yield"
        projectId="project_original"
        providerAccess={providerAccess}
        strategyId={liveStrategy.id}
      />
    );

    expect(screen.getAllByText("Kamino USDC Vault").length).toBeGreaterThan(0);
    expect(screen.getByRole("alert").textContent).toContain(
      "The saved Embedded Yield button configuration could not be loaded"
    );
    expect(screen.getByRole("button", { name: "Save configuration" })).toHaveProperty(
      "disabled",
      false
    );
  });

  it("renders a mainnet vault as a sandbox preview without offering persistence", () => {
    renderWithEnglish(
      <EarnButtonBuilder
        configurationLoad={noConfiguration}
        configureHref="/dashboard/markets/embedded-yield/configure"
        earnHref="/dashboard/markets/embedded-yield"
        projectId="project_original"
        providerAccess={providerAccess}
        strategyCluster="mainnet-beta"
        strategyId={mainnetStrategy.id}
      />
    );

    expect(mocks.strategyClusters).toContain("mainnet-beta");
    expect(screen.getAllByText("Kamino JLP Vault").length).toBeGreaterThan(0);
    expect(screen.getByText("Mainnet vault preview")).toBeTruthy();
    expect(screen.getByText(/Production project is required/)).toBeTruthy();
    expect(
      screen.getByText(/Public handoff links are created from a Production project/)
    ).toBeTruthy();
    expect(screen.getByText(/strategyId: "earn_strategy_mainnet"/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save configuration" })).toHaveProperty(
      "disabled",
      true
    );
    expect(screen.getByRole("link", { name: "Change strategy" }).getAttribute("href")).toBe(
      "/dashboard/markets/embedded-yield/configure?cluster=mainnet-beta"
    );
    expect(mocks.saveEarnButtonConfiguration).not.toHaveBeenCalled();
  });

  it("does not let a mainnet deep link bypass provider access", () => {
    mocks.mainnetFundable = true;
    renderWithEnglish(
      <EarnButtonBuilder
        configurationLoad={noConfiguration}
        configureHref="/dashboard/markets/embedded-yield/configure"
        earnHref="/dashboard/markets/embedded-yield"
        projectId="project_original"
        providerAccess={{ kamino: { entitled: false, configured: true, enabled: false } }}
        strategyCluster="mainnet-beta"
        strategyId={mainnetStrategy.id}
      />
    );

    expect(screen.getByText("Strategy deposits unavailable")).toBeTruthy();
    expect(screen.getByText(/provider is not enabled/)).toBeTruthy();
    expect(screen.queryByText("Mainnet vault preview")).toBeNull();
  });

  it("dead-ends on a failed configuration load only when no strategy is selected", () => {
    renderWithEnglish(
      <EarnButtonBuilder
        configurationLoad={{ kind: "error" }}
        earnHref="/dashboard/markets/embedded-yield"
        projectId="project_original"
        providerAccess={providerAccess}
      />
    );

    expect(screen.getByText("Button configuration unavailable")).toBeTruthy();
    expect(screen.queryByText("Server integration")).toBeNull();
  });

  it("asks for a strategy when none is selected and nothing is saved", () => {
    renderWithEnglish(
      <EarnButtonBuilder
        configurationLoad={noConfiguration}
        earnHref="/dashboard/markets/embedded-yield"
        projectId="project_original"
        providerAccess={providerAccess}
      />
    );

    expect(screen.getByText("Choose a strategy first")).toBeTruthy();
    expect(screen.getByText(/select a live strategy/)).toBeTruthy();
  });

  it("falls through an empty strategy parameter to the saved configuration", () => {
    renderWithEnglish(
      <EarnButtonBuilder
        configurationLoad={{ kind: "ready", configuration: savedConfiguration }}
        earnHref="/dashboard/markets/embedded-yield"
        projectId="project_original"
        providerAccess={providerAccess}
        strategyId=""
      />
    );

    expect(screen.getAllByText("Kamino USDC Vault").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("link", {
        name: /embedded-yield\/integrate\/PublicEarnButtonToken123/,
      })
    ).toBeTruthy();
  });

  it("restores the saved strategy, style, and handoff link without a query parameter", () => {
    renderWithEnglish(
      <EarnButtonBuilder
        configurationLoad={{ kind: "ready", configuration: savedConfiguration }}
        earnHref="/dashboard/markets/embedded-yield"
        projectId="project_original"
        providerAccess={providerAccess}
      />
    );

    const lightRadio = screen.getByRole("radio", { name: /^Light/ }) as HTMLInputElement;
    expect(lightRadio.checked).toBe(true);
    expect(screen.getAllByText("Kamino USDC Vault").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("link", {
        name: /embedded-yield\/integrate\/PublicEarnButtonToken123/,
      })
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save configuration" })).toHaveProperty(
      "disabled",
      true
    );
  });

  it("restores the save action after an unexpected request failure", async () => {
    const user = userEvent.setup();
    mocks.saveEarnButtonConfiguration.mockRejectedValue(new Error("Network unavailable"));
    renderWithEnglish(
      <EarnButtonBuilder
        configurationLoad={noConfiguration}
        earnHref="/dashboard/markets/embedded-yield"
        projectId="project_original"
        providerAccess={providerAccess}
        strategyId={liveStrategy.id}
      />
    );

    await user.click(screen.getByRole("button", { name: "Save configuration" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Network unavailable");
    expect(screen.getByRole("button", { name: "Save configuration" })).toHaveProperty(
      "disabled",
      false
    );
  });

  it("clears the prior project's style and handoff when the project scope changes", async () => {
    const view = renderWithEnglish(
      <EarnButtonBuilder
        configurationLoad={{ kind: "ready", configuration: savedConfiguration }}
        earnHref="/dashboard/markets/embedded-yield"
        key="saved-configuration"
        projectId="project_original"
        providerAccess={providerAccess}
      />
    );

    view.rerender(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <EarnButtonBuilder
          configurationLoad={noConfiguration}
          earnHref="/dashboard/markets/embedded-yield"
          key="empty-configuration"
          projectId="project_next"
          providerAccess={providerAccess}
          strategyId={liveStrategy.id}
        />
      </I18nProvider>
    );

    await waitFor(() => {
      expect((screen.getByRole("radio", { name: /^Ink/ }) as HTMLInputElement).checked).toBe(true);
    });
    expect(screen.queryByRole("link", { name: /embedded-yield\/integrate\// })).toBeNull();
  });

  it("offers a recovery route when the live strategy id no longer resolves", () => {
    renderWithEnglish(
      <EarnButtonBuilder
        configurationLoad={noConfiguration}
        earnHref="/dashboard/markets/embedded-yield"
        projectId="project_original"
        providerAccess={providerAccess}
        strategyId="earn_strategy_removed"
      />
    );

    expect(screen.getByText("Strategy no longer available")).toBeTruthy();
    expect(screen.getByText(/no longer in the live catalogue/)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Return to Embedded Yield" }).getAttribute("href")
    ).toBe("/dashboard/markets/embedded-yield");
    expect(screen.queryByText("iOS preview")).toBeNull();
  });

  it("refuses a deep link when the selected environment cannot fund the strategy", () => {
    mocks.environment = "production";
    renderWithEnglish(
      <EarnButtonBuilder
        configurationLoad={noConfiguration}
        earnHref="/dashboard/markets/embedded-yield"
        projectId="project_original"
        providerAccess={providerAccess}
        strategyId="earn_strategy_live"
      />
    );

    expect(screen.getByText("Strategy deposits unavailable")).toBeTruthy();
    expect(screen.getByText(/sandbox-only/)).toBeTruthy();
    expect(screen.queryByText("Server integration")).toBeNull();
  });

  it("names provider setup as the reason an otherwise live strategy cannot be configured", () => {
    renderWithEnglish(
      <EarnButtonBuilder
        configurationLoad={noConfiguration}
        earnHref="/dashboard/markets/embedded-yield"
        projectId="project_original"
        providerAccess={{ kamino: { entitled: true, configured: false, enabled: false } }}
        strategyId="earn_strategy_live"
      />
    );

    expect(screen.getByText("Strategy deposits unavailable")).toBeTruthy();
    expect(screen.getByText(/provider is not enabled/)).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
  });
});
