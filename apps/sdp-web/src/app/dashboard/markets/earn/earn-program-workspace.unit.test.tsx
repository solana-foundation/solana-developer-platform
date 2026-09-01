// @vitest-environment jsdom

import type { EarnStrategy, SolanaCluster } from "@sdp/types";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { EarnProgramWorkspace } from "./earn-program-workspace";

const mocks = vi.hoisted(() => ({
  environment: "sandbox" as "sandbox" | "production",
  push: vi.fn(),
  strategyClusters: [] as Array<SolanaCluster | undefined>,
}));

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

// Delayed liquidity with no observed APY: the table must name the redemption
// delay and keep the APY placeholder rather than fabricating a rate.
const delayedStrategy: EarnStrategy = {
  id: "earn_strategy_delayed",
  provider: "veda",
  providerReference: "VedaFund1111111111111111111111111111111111",
  name: "Veda Treasury Fund",
  sourceKind: "rwa",
  depositMints: ["So11111111111111111111111111111111111111112"],
  shareMint: "ShareDelayed111111111111111111111111111111",
  apyType: "fixed",
  liquidityTerm: "delayed",
  redemptionDelayDays: 7,
  status: "active",
  hostCluster: "devnet",
  fundable: true,
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:00.000Z",
};

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({ sdpEnvironment: mocks.environment }),
}));

vi.mock("./earn-program-data", () => ({
  useEarnStrategies: (options?: { cluster?: SolanaCluster }) => {
    mocks.strategyClusters.push(options?.cluster);
    return {
      strategies:
        options?.cluster === "mainnet-beta" ? [mainnetStrategy] : [liveStrategy, delayedStrategy],
      error: undefined,
      isLoading: false,
    };
  },
}));

function renderWithEnglish(children: ReactNode) {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      {children}
    </I18nProvider>
  );
}

function getDesktopStrategyRow(name: string) {
  const row = screen
    .getAllByText(name)
    .map((element) => element.closest("tr"))
    .find((element) => element !== null);
  if (!row) throw new Error(`Expected the desktop strategy row for ${name}`);
  return row;
}

beforeEach(() => {
  mocks.environment = "sandbox";
  mocks.push.mockClear();
  mocks.strategyClusters.length = 0;
});

afterEach(cleanup);

describe("EarnProgramWorkspace", () => {
  const providerAccess = {
    kamino: { entitled: true, configured: true, enabled: true },
  } as const;

  it("selects a live provider strategy and routes its canonical id to the integration guide", async () => {
    const user = userEvent.setup();
    renderWithEnglish(
      <EarnProgramWorkspace
        integrateHref="/dashboard/markets/embedded-yield/integrate"
        providerAccess={providerAccess}
      />
    );

    const row = getDesktopStrategyRow("Kamino USDC Vault");
    expect(row.textContent).toContain("6.2%");
    expect(row.textContent).toContain("Sandbox ready");

    await user.click(within(row).getByRole("button", { name: "Select" }));
    await user.click(screen.getByRole("button", { name: "Continue to integration" }));

    expect(mocks.push).toHaveBeenCalledWith(
      "/dashboard/markets/embedded-yield/integrate?strategy=earn_strategy_live"
    );
    expect(document.body.textContent).not.toContain("Mock");
    const desktopTable = screen.getByRole("region");
    expect(desktopTable.className).toContain("[&_table]:min-w-[64rem]");
    expect(desktopTable.className).toContain("[&_table]:table-fixed");
    expect(desktopTable.getAttribute("style")).toBeNull();
  });

  it("renders liquidity and provider for every catalogue row (PRO-1721)", () => {
    renderWithEnglish(
      <EarnProgramWorkspace
        integrateHref="/dashboard/markets/embedded-yield/integrate"
        providerAccess={providerAccess}
      />
    );

    const instantRow = getDesktopStrategyRow("Kamino USDC Vault");
    expect(within(instantRow).getByText("Instant")).toBeTruthy();
    // The human provider label, never the raw id.
    expect(within(instantRow).getByText("Kamino")).toBeTruthy();

    const delayedRow = getDesktopStrategyRow("Veda Treasury Fund");
    expect(within(delayedRow).getByText("Delayed · 7 days")).toBeTruthy();
    expect(within(delayedRow).getByText("Veda")).toBeTruthy();
    // No observed APY renders the placeholder, never a fabricated rate.
    expect(within(delayedRow).getByText("—")).toBeTruthy();
    expect(delayedRow.textContent).not.toMatch(/\d%/);
  });

  it("previews a mainnet strategy from sandbox with explicit warnings", async () => {
    const user = userEvent.setup();
    renderWithEnglish(
      <EarnProgramWorkspace
        integrateHref="/dashboard/markets/embedded-yield/integrate"
        providerAccess={providerAccess}
      />
    );

    const toggle = screen.getByLabelText("Strategy network");
    await user.click(within(toggle).getByRole("button", { name: "Mainnet" }));

    expect(mocks.strategyClusters).toContain("mainnet-beta");
    const row = getDesktopStrategyRow("Kamino JLP Vault");
    expect(row.textContent).toContain("Mainnet only");

    await user.click(within(row).getByRole("button", { name: "Select" }));
    expect(screen.getByRole("alert").textContent).toContain("Mainnet vault preview");
    await user.click(screen.getByRole("button", { name: "Continue to integration" }));

    expect(mocks.push).toHaveBeenCalledWith(
      "/dashboard/markets/embedded-yield/integrate?strategy=earn_strategy_mainnet&cluster=mainnet-beta"
    );
  });

  it("does not offer a production deposit flow before vault withdrawals exist", () => {
    mocks.environment = "production";
    renderWithEnglish(
      <EarnProgramWorkspace
        integrateHref="/dashboard/markets/embedded-yield/integrate"
        providerAccess={providerAccess}
      />
    );

    // The shelf size is a BD decision (EARN_PROVIDER_SURFACING), so assert the
    // invariant per rendered instance — every strategy (desktop row + mobile
    // card) is production-closed — rather than pinning a count.
    const selectButtons = screen.getAllByRole("button", { name: "Select" });
    expect(screen.getAllByText("Sandbox only")).toHaveLength(selectButtons.length);
    expect(screen.queryByText("Sandbox ready")).toBeNull();
    expect(screen.queryByLabelText("Strategy network")).toBeNull();
    expect(selectButtons.every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    expect(document.body.textContent).toContain("intentionally closed in production");
  });

  it("fails closed when the organization provider is not enabled", () => {
    renderWithEnglish(
      <EarnProgramWorkspace
        integrateHref="/dashboard/markets/embedded-yield/integrate"
        providerAccess={{
          kamino: { entitled: false, configured: true, enabled: false },
        }}
      />
    );

    // Same rule as the production test above: no access entry means every
    // surfaced provider fails closed, however many are surfaced today.
    const selectButtons = screen.getAllByRole("button", { name: "Select" });
    expect(screen.getAllByText("Setup required")).toHaveLength(selectButtons.length);
    expect(screen.queryByText("Sandbox ready")).toBeNull();
    expect(selectButtons.every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
  });
});
