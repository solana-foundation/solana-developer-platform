// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { TreasurySolutionsWorkspace } from "./treasury-solutions-workspace";

const mocks = vi.hoisted(() => ({
  environment: "sandbox" as "sandbox" | "production",
  programProvider: "ground",
  refreshStrategies: vi.fn(),
  refreshPositions: vi.fn(),
  refreshPrograms: vi.fn(),
  refreshWallets: vi.fn(),
  withdrawalsByProgram: {} as Record<string, Array<{ status: string; withdrawalRef?: string }>>,
  vaultDeposits: [] as Array<{ movementId: string; status: string }>,
}));

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({ sdpEnvironment: mocks.environment }),
}));

vi.mock("../earn/deposit/earn-funding-wallets", () => ({
  useEarnFundingWallets: () => ({
    error: undefined,
    isLoading: false,
    refresh: mocks.refreshWallets,
    wallets: [
      {
        id: "cwlt_live",
        custodyConfigId: "custody_live",
        isRuntimeExecutionAllowed: true,
        walletId: "privy_live",
        publicKey: "LiveWallet111111111111111111111111111111111",
        label: "Operating treasury",
        purpose: null,
        status: "active",
        createdAt: "2026-08-18T00:00:00.000Z",
        provider: "privy",
        balances: [
          {
            token: "USDC",
            mint: USDC_MINT,
            amount: "2500000000",
            uiAmount: "2500",
            decimals: 6,
          },
        ],
      },
    ],
  }),
}));

vi.mock("../earn/earn-program-data", () => ({
  useEarnStrategies: () => ({
    error: undefined,
    isLoading: false,
    refresh: mocks.refreshStrategies,
    strategies: [
      {
        id: "earn_strategy_live",
        provider: "kamino",
        providerReference: "Kvault11111111111111111111111111111111111",
        name: "Kamino USDC Vault",
        sourceKind: "defi",
        depositMints: [USDC_MINT],
        shareMint: "Share1111111111111111111111111111111111111",
        apyType: "variable",
        currentApy: "0.062",
        liquidityTerm: "instant",
        status: "active",
        hostCluster: "devnet",
        fundable: true,
        createdAt: "2026-08-18T00:00:00.000Z",
        updatedAt: "2026-08-18T00:00:00.000Z",
      },
    ],
  }),
  useEarnVaultPositions: () => ({
    error: undefined,
    isLoading: false,
    refresh: mocks.refreshPositions,
    positions: [
      {
        id: "earn_vault_position_live",
        provider: "kamino",
        providerReference: "Kvault11111111111111111111111111111111111",
        label: "Kamino USDC Vault",
        custodyWalletId: "cwlt_live",
        tokenMint: USDC_MINT,
        shareMint: "Share1111111111111111111111111111111111111",
        createdAt: "2026-08-18T00:00:00.000Z",
        closedAt: null,
        shares: "119.5",
        tokenValue: "125.25",
      },
      {
        id: "earn_vault_position_retired",
        provider: "kamino",
        providerReference: "KvaultRetired111111111111111111111111111111",
        label: "Retired provider vault",
        custodyWalletId: "cwlt_live",
        tokenMint: USDC_MINT,
        shareMint: "ShareRetired1111111111111111111111111111111",
        createdAt: "2026-08-17T00:00:00.000Z",
        closedAt: null,
        shares: "5",
        tokenValue: "5.25",
      },
    ],
  }),
  useEarnPrograms: () => ({
    error: undefined,
    isLoading: false,
    refresh: mocks.refreshPrograms,
    state: {
      kind: "ready",
      programs: [
        {
          id: "earn_program_ground",
          provider: mocks.programProvider,
          label: "Legacy treasury program",
          createdAt: "2026-08-01T00:00:00.000Z",
          wallet: {
            providerWalletRef: "ground_wallet",
            status: "ready",
            balance: {
              totalUsd: "900.50",
              withdrawableUsd: "880.25",
              reservedUsd: "20.25",
              earnedUsd: "5.50",
            },
            positions: [],
            allocations: {},
          },
        },
        {
          id: "earn_program_ground_secondary",
          provider: mocks.programProvider,
          label: "Secondary treasury program",
          createdAt: "2026-08-02T00:00:00.000Z",
          wallet: {
            providerWalletRef: "ground_wallet_secondary",
            status: "ready",
            balance: {
              totalUsd: "100.00",
              withdrawableUsd: "100.00",
              reservedUsd: "0",
              earnedUsd: "1.00",
            },
            positions: [],
            allocations: {},
          },
        },
      ],
    },
  }),
  useEarnProgramWithdrawals: (programId: string) => ({
    error: undefined,
    isLoading: false,
    refresh: vi.fn(),
    withdrawals: mocks.withdrawalsByProgram[programId] ?? [],
  }),
  useEarnVaultDeposits: () => ({
    deposits: mocks.vaultDeposits,
    error: undefined,
    isLoading: false,
    refresh: vi.fn(),
  }),
  // The real predicate, not a stub: the recovery filter and the tracker's stop
  // condition must agree, and a stub here would let them drift silently.
  isEarnVaultDepositInFlight: (deposit: { status: string }) =>
    deposit.status !== "confirmed" && deposit.status !== "failed",
}));

vi.mock("../earn/earn-vault-deposit-modal", () => ({
  EarnVaultDepositModal: ({ strategy }: { strategy: { name: string } }) => (
    <div role="dialog">Deposit into {strategy.name}</div>
  ),
  EarnVaultDepositOutcomeTracker: ({ movementId }: { movementId: string }) => (
    <output data-testid="vault-deposit-outcome-tracker">{movementId}</output>
  ),
}));

vi.mock("../earn/earn-withdraw-modal", () => ({
  EarnWithdrawalOutcomeTracker: ({
    programId,
    withdrawalRef,
  }: {
    programId: string;
    withdrawalRef: string;
  }) => <output data-testid="withdrawal-outcome-tracker">{`${programId}:${withdrawalRef}`}</output>,
  EarnWithdrawModal: ({ programId }: { programId: string }) => (
    <div role="dialog">Withdraw from {programId}</div>
  ),
}));

function renderWorkspace() {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <TreasurySolutionsWorkspace
        providerAccess={{
          kamino: { entitled: true, configured: true, enabled: true },
        }}
      />
    </I18nProvider>
  );
}

beforeEach(() => {
  mocks.environment = "sandbox";
  mocks.programProvider = "ground";
  mocks.withdrawalsByProgram = {};
  mocks.vaultDeposits = [];
  vi.clearAllMocks();
});

afterEach(cleanup);

describe("TreasurySolutionsWorkspace", () => {
  it("renders live wallets, vault positions, and existing provider programs", async () => {
    const user = userEvent.setup();
    renderWorkspace();

    expect(screen.getAllByText("Operating treasury").length).toBeGreaterThan(0);
    expect(screen.getByText("2,500")).toBeTruthy();

    const vaultRows = screen
      .getAllByText("Kamino USDC Vault")
      .map((element) => element.closest("tr"))
      .filter((row): row is HTMLTableRowElement => row !== null);
    const vaultPositionRow = vaultRows.find((row) => row.textContent?.includes("119.5"));
    const vaultStrategyRow = vaultRows.find((row) => row.textContent?.includes("6.2%"));
    if (!vaultPositionRow || !vaultStrategyRow) {
      throw new Error("Expected separate vault position and strategy rows");
    }
    expect(vaultPositionRow.textContent).toContain("125.25 USDC");
    expect(vaultStrategyRow.textContent).toContain("6.2%");
    expect(screen.getByText("Retired provider vault")).toBeTruthy();

    const vaultWithdraw = within(vaultPositionRow).getByRole("button", { name: "Withdraw" });
    expect((vaultWithdraw as HTMLButtonElement).disabled).toBe(true);
    expect(vaultWithdraw.getAttribute("title")).toContain("not available through SDP yet");
    expect(screen.getByText("Vault withdrawals are not available through SDP yet.")).toBeTruthy();

    await user.click(within(vaultStrategyRow).getByRole("button", { name: "Deposit" }));
    expect(screen.getByRole("dialog").textContent).toBe("Deposit into Kamino USDC Vault");

    const legacyRow = screen.getByText("Legacy treasury program").closest("tr");
    if (!legacyRow) throw new Error("Expected existing Ground program row");
    expect(legacyRow.textContent).toContain("900.50 USD");
  });

  it("keeps vault deposits disabled in production", () => {
    mocks.environment = "production";
    renderWorkspace();

    const row = screen
      .getAllByText("Kamino USDC Vault")
      .map((element) => element.closest("tr"))
      .find((candidate) => candidate?.textContent?.includes("6.2%"));
    if (!row) throw new Error("Expected vault strategy row");
    expect(
      (within(row).getByRole("button", { name: "Deposit" }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(document.body.textContent).toContain("new vault deposits stay disabled");
  });

  it("fails closed when a persisted program provider has no Solana withdrawal lane", () => {
    mocks.programProvider = "future-provider";
    renderWorkspace();

    const programRow = screen.getByText("Legacy treasury program").closest("tr");
    if (!programRow) throw new Error("Expected existing provider program row");
    expect(
      (within(programRow).getByRole("button", { name: "Withdraw" }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(within(programRow).getByText("Provider withdrawal unavailable")).toBeTruthy();
  });

  it("recovers every provider-accepted in-flight withdrawal from the durable ledger", async () => {
    mocks.withdrawalsByProgram = {
      earn_program_ground: [
        { status: "processing", withdrawalRef: "withdrawal_processing" },
        // A repeated ledger result must still mount only one keyed tracker.
        { status: "processing", withdrawalRef: "withdrawal_processing" },
        { status: "pending_approval", withdrawalRef: "withdrawal_approval" },
        // No provider operation exists yet, even if malformed data carries a ref.
        { status: "requested", withdrawalRef: "must_not_poll_requested" },
        { status: "completed", withdrawalRef: "must_not_poll_terminal" },
        // A provider ref is required to name the canonical live GET.
        { status: "processing" },
      ],
      earn_program_ground_secondary: [
        { status: "processing", withdrawalRef: "withdrawal_secondary" },
      ],
    };

    renderWorkspace();

    await waitFor(() => {
      expect(screen.getAllByTestId("withdrawal-outcome-tracker")).toHaveLength(3);
    });
    expect(
      screen
        .getAllByTestId("withdrawal-outcome-tracker")
        .map((tracker) => tracker.textContent)
        .sort()
    ).toEqual([
      "earn_program_ground:withdrawal_approval",
      "earn_program_ground:withdrawal_processing",
      "earn_program_ground_secondary:withdrawal_secondary",
    ]);
    expect(document.body.textContent).not.toContain("must_not_poll_requested");
    expect(document.body.textContent).not.toContain("must_not_poll_terminal");
  });

  it("recovers every in-flight vault deposit from the server ledger", async () => {
    mocks.vaultDeposits = [
      // `pending` is IN FLIGHT, not failed: SDP could not establish that the
      // transaction reached the network, and the sweep is still working on it.
      { movementId: "earn_vault_movement_pending", status: "pending" },
      { movementId: "earn_vault_movement_submitted", status: "submitted" },
      // A repeated ledger result must still mount only one keyed tracker.
      { movementId: "earn_vault_movement_submitted", status: "submitted" },
      { movementId: "earn_vault_movement_confirmed", status: "confirmed" },
      { movementId: "earn_vault_movement_failed", status: "failed" },
    ];

    renderWorkspace();

    await waitFor(() => {
      expect(screen.getAllByTestId("vault-deposit-outcome-tracker")).toHaveLength(2);
    });
    expect(
      screen
        .getAllByTestId("vault-deposit-outcome-tracker")
        .map((tracker) => tracker.textContent)
        .sort()
    ).toEqual(["earn_vault_movement_pending", "earn_vault_movement_submitted"]);
    // Already settled: re-watching them would re-announce an outcome the
    // customer was told about the first time round.
    expect(document.body.textContent).not.toContain("earn_vault_movement_confirmed");
    expect(document.body.textContent).not.toContain("earn_vault_movement_failed");
  });

  it("mounts no deposit tracker when the ledger reports nothing in flight", async () => {
    mocks.vaultDeposits = [{ movementId: "earn_vault_movement_done", status: "confirmed" }];

    renderWorkspace();

    // Anchor on a real render so this cannot pass by asserting against a page
    // that never mounted.
    await waitFor(() => expect(screen.getByText("Legacy treasury program")).toBeTruthy());
    expect(screen.queryAllByTestId("vault-deposit-outcome-tracker")).toHaveLength(0);
  });
});
