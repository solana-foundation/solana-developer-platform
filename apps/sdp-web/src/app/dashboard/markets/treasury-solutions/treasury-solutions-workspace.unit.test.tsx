// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { TreasurySolutionsWorkspace } from "./treasury-solutions-workspace";

// jsdom implements no matchMedia, and the design-system SegmentedControl (the
// PRO-1742 cluster toggle) reads it through motion's useReducedMotion.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const mocks = vi.hoisted(() => ({
  environment: "sandbox" as "sandbox" | "production",
  programProvider: "ground",
  // Every cluster value useEarnStrategies was asked for, across renders.
  strategiesClusterRequests: [] as Array<"devnet" | "mainnet-beta" | undefined>,
  refreshStrategies: vi.fn(),
  refreshPositions: vi.fn(),
  refreshPrograms: vi.fn(),
  refreshWallets: vi.fn(),
  withdrawalsByProgram: {} as Record<string, Array<{ status: string; withdrawalRef?: string }>>,
  vaultDeposits: [] as Array<{ movementId: string; status: string }>,
  vaultWithdrawals: [] as Array<{ movementId: string; status: string }>,
  walletBalances: undefined as
    | Array<{
        token: string;
        mint: string;
        amount: string;
        uiAmount: string;
        decimals: number;
        usdPrice?: number;
      }>
    | undefined,
  livePositionTokenValue: "125.25" as string | undefined,
  positionsError: false,
  positionsEmpty: false,
  strategiesUnavailable: false,
  strategiesStaleError: false,
  strategyMissingShareMint: false,
  walletsError: false,
  corruptStableShareMint: false,
  secondWalletBalances: undefined as
    | Array<{ token: string; mint: string; amount: string; uiAmount: string; decimals: number }>
    | undefined,
}));

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SHARE_MINT = "Share1111111111111111111111111111111111111";
// A share mint known only through the strategy catalogue — no position row.
const CATALOGUE_SHARE_MINT = "ShareCatalogue11111111111111111111111111111";

vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({ sdpEnvironment: mocks.environment }),
}));

vi.mock("../earn/deposit/earn-funding-wallets", () => ({
  useEarnFundingWallets: () => ({
    error: mocks.walletsError ? new Error("wallets unavailable") : undefined,
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
        balances: mocks.walletBalances,
      },
      ...(mocks.secondWalletBalances
        ? [
            {
              id: "cwlt_second",
              custodyConfigId: "custody_live",
              isRuntimeExecutionAllowed: true,
              walletId: "privy_second",
              publicKey: "SecondWallet1111111111111111111111111111111",
              label: "Reserve treasury",
              purpose: null,
              status: "active",
              createdAt: "2026-08-18T00:00:00.000Z",
              provider: "privy",
              balances: mocks.secondWalletBalances,
            },
          ]
        : []),
    ],
  }),
}));

vi.mock("../earn/earn-program-data", () => ({
  useEarnStrategies: (options?: { cluster?: "devnet" | "mainnet-beta" }) => {
    mocks.strategiesClusterRequests.push(options?.cluster);
    // The mirrored mainnet shelf (PRO-1742), served only on the explicit
    // opt-in — rows arrive `fundable: false`, exactly as the API derives them.
    if (options?.cluster === "mainnet-beta") {
      return {
        error: undefined,
        isLoading: false,
        refresh: mocks.refreshStrategies,
        strategies: [
          {
            id: "earn_strategy_mainnet_mirror",
            provider: "kamino",
            providerReference: "KvaultMainnet111111111111111111111111111111",
            name: "Kamino JLP Vault",
            sourceKind: "defi",
            depositMints: [USDC_MINT],
            shareMint: "ShareMainnet111111111111111111111111111111",
            apyType: "variable",
            currentApy: "0.081",
            liquidityTerm: "instant",
            status: "active",
            hostCluster: "mainnet-beta",
            fundable: false,
            createdAt: "2026-08-18T00:00:00.000Z",
            updatedAt: "2026-08-18T00:00:00.000Z",
          },
        ],
      };
    }
    return {
      error:
        mocks.strategiesUnavailable || mocks.strategiesStaleError
          ? new Error("catalogue unavailable")
          : undefined,
      isLoading: false,
      refresh: mocks.refreshStrategies,
      strategies: mocks.strategiesUnavailable
        ? undefined
        : [
            {
              id: "earn_strategy_live",
              provider: "kamino",
              providerReference: "Kvault11111111111111111111111111111111111",
              name: "Kamino USDC Vault",
              sourceKind: "defi",
              depositMints: [USDC_MINT],
              shareMint: SHARE_MINT,
              apyType: "variable",
              currentApy: "0.062",
              liquidityTerm: "instant",
              status: "active",
              hostCluster: "devnet",
              fundable: true,
              createdAt: "2026-08-18T00:00:00.000Z",
              updatedAt: "2026-08-18T00:00:00.000Z",
            },
            {
              id: "earn_strategy_catalogue_only",
              provider: "kamino",
              providerReference: "KvaultCatalogue1111111111111111111111111111",
              name: "Kamino PYUSD Vault",
              sourceKind: "defi",
              depositMints: [USDC_MINT],
              ...(mocks.strategyMissingShareMint
                ? {}
                : { shareMint: mocks.corruptStableShareMint ? USDC_MINT : CATALOGUE_SHARE_MINT }),
              apyType: "variable",
              currentApy: "0.041",
              liquidityTerm: "instant",
              status: "active",
              hostCluster: "devnet",
              fundable: true,
              createdAt: "2026-08-18T00:00:00.000Z",
              updatedAt: "2026-08-18T00:00:00.000Z",
            },
          ],
    };
  },
  useEarnVaultPositions: () => ({
    // Real SWR keeps stale data alongside an error; the workspace guard is
    // what must refuse to render it as live.
    error: mocks.positionsError ? new Error("positions unavailable") : undefined,
    isLoading: false,
    refresh: mocks.refreshPositions,
    positions: mocks.positionsEmpty
      ? []
      : [
          {
            id: "earn_vault_position_live",
            provider: "kamino",
            providerReference: "Kvault11111111111111111111111111111111111",
            label: "Kamino USDC Vault",
            custodyWalletId: "cwlt_live",
            tokenMint: USDC_MINT,
            shareMint: SHARE_MINT,
            createdAt: "2026-08-18T00:00:00.000Z",
            closedAt: null,
            shares: "119.5",
            tokenValue: mocks.livePositionTokenValue,
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
          {
            id: "earn_vault_position_exited",
            provider: "kamino",
            providerReference: "KvaultExited1111111111111111111111111111111",
            label: "Exited provider vault",
            custodyWalletId: "cwlt_live",
            tokenMint: USDC_MINT,
            shareMint: "ShareExited11111111111111111111111111111111",
            createdAt: "2026-08-16T00:00:00.000Z",
            closedAt: null,
            shares: "0",
            tokenValue: "0",
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
  useEarnVaultWithdrawals: () => ({
    withdrawals: mocks.vaultWithdrawals,
    error: undefined,
    isLoading: false,
    refresh: vi.fn(),
  }),
  // The real predicates, not stubs: each recovery filter and its tracker's
  // stop condition must agree, and a stub here would let them drift silently.
  // Note the two vocabularies differ on purpose: the deposit DTO is legacy
  // (confirmed is terminal), the withdrawal DTO is the unified ledger's
  // (confirmed is still in flight; finalized is terminal).
  isEarnVaultDepositInFlight: (deposit: { status: string }) =>
    deposit.status !== "confirmed" && deposit.status !== "failed",
  isEarnVaultWithdrawalInFlight: (withdrawal: { status: string }) =>
    withdrawal.status !== "finalized" && withdrawal.status !== "failed",
}));

vi.mock("../earn/earn-vault-withdraw-modal", () => ({
  EarnVaultWithdrawModal: ({ position }: { position: { label: string } }) => (
    <div role="dialog">Withdraw from {position.label}</div>
  ),
  EarnVaultWithdrawalOutcomeTracker: ({ movementId }: { movementId: string }) => (
    <output data-testid="vault-withdrawal-outcome-tracker">{movementId}</output>
  ),
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
  mocks.strategiesClusterRequests = [];
  mocks.withdrawalsByProgram = {};
  mocks.vaultDeposits = [];
  mocks.vaultWithdrawals = [];
  mocks.walletBalances = [
    { token: "USDC", mint: USDC_MINT, amount: "2500000000", uiAmount: "2500", decimals: 6 },
    // The vault receipt token the custody wallet actually holds on chain, for
    // a position that IS recorded. It must render as vault ownership, never as
    // a token tile.
    { token: "kUSDC", mint: SHARE_MINT, amount: "119500000", uiAmount: "119.5", decimals: 6 },
  ];
  mocks.livePositionTokenValue = "125.25";
  mocks.positionsError = false;
  mocks.positionsEmpty = false;
  mocks.strategiesUnavailable = false;
  mocks.strategiesStaleError = false;
  mocks.secondWalletBalances = undefined;
  mocks.strategyMissingShareMint = false;
  mocks.walletsError = false;
  mocks.corruptStableShareMint = false;
  vi.clearAllMocks();
});

afterEach(cleanup);

describe("TreasurySolutionsWorkspace", () => {
  it("renders live wallets, vault positions, and existing provider programs", async () => {
    const user = userEvent.setup();
    renderWorkspace();

    expect(screen.getAllByText("Operating treasury").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$2,500.00").length).toBeGreaterThan(0);

    const vaultRows = screen
      .getAllByText("Kamino USDC Vault")
      .map((element) => element.closest("tr"))
      .filter((row): row is HTMLTableRowElement => row !== null);
    const vaultPositionRow = vaultRows.find((row) =>
      within(row).queryByRole("button", { name: "Withdraw" })
    );
    const vaultStrategyRow = vaultRows.find((row) => row.textContent?.includes("6.2%"));
    if (!vaultPositionRow || !vaultStrategyRow) {
      throw new Error("Expected separate vault position and strategy rows");
    }
    expect(vaultStrategyRow.textContent).toContain("6.2%");

    // PRO-1723: the allocation summary totals the float above the tables.
    expect(screen.getByText("Deposited")).toBeTruthy();
    expect(screen.getAllByText("Available cash").length).toBeGreaterThan(0);
    expect(screen.getByText("Est. APY")).toBeTruthy();
    expect(screen.getByLabelText("$130.50 in open vault positions")).toBeTruthy();

    // Vault ownership renders as the wallet's deployed line, never as a
    // receipt-token tile or a raw share count.
    expect(screen.queryByText("kUSDC")).toBeNull();
    expect(screen.queryByText("119.5")).toBeNull();
    expect(screen.getByText("Deployed in vaults")).toBeTruthy();
    expect(screen.getAllByText("$130.50").length).toBeGreaterThan(0);
    expect(screen.getByText("Retired provider vault")).toBeTruthy();
    expect(screen.queryByText("Exited provider vault")).toBeNull();

    // The exit verb is LIVE (PRO-1702) and takes no availability gate: money
    // out beats money off, so it stays enabled even where deposits are not.
    const vaultWithdraw = within(vaultPositionRow).getByRole("button", { name: "Withdraw" });
    expect((vaultWithdraw as HTMLButtonElement).disabled).toBe(false);

    await user.click(within(vaultStrategyRow).getByRole("button", { name: "Deposit" }));
    expect(screen.getByRole("dialog").textContent).toBe("Deposit into Kamino USDC Vault");

    const legacyRow = screen.getByText("Legacy treasury program").closest("tr");
    if (!legacyRow) throw new Error("Expected existing Ground program row");
    expect(legacyRow.textContent).toContain("900.50 USD");
  });

  it("reads an unreadable wallet balance as unavailable across every figure, never zero", () => {
    mocks.walletBalances = undefined;
    renderWorkspace();

    expect(screen.getByLabelText("A wallet balance could not be read")).toBeTruthy();
    // Deployed goes unavailable too: an unread wallet may hold a receipt token
    // with no recorded position, so the recorded sum is not a certified total.
    expect(screen.getByLabelText("A position value could not be read")).toBeTruthy();
    expect(screen.queryByLabelText("$130.50 in open vault positions")).toBeNull();
    expect(screen.queryByText("$0.00")).toBeNull();
    expect(screen.queryByText("$2,500.00")).toBeNull();
    expect(screen.queryByText("100.0%")).toBeNull();
    // And the strategy rows stop claiming an absence they cannot support.
    expect(screen.queryByText("No active position")).toBeNull();
  });

  it("counts an SDP-issued stablecoin the static catalogue cannot know", () => {
    // The API prices what it treats as USD-stable at exactly 1, issued tokens
    // included. Dropping those understated the float, and a wallet holding
    // only them read $0.00 with a confident 100% deployed.
    mocks.walletBalances = [
      {
        token: "kUSDC",
        mint: SHARE_MINT,
        amount: "119500000",
        uiAmount: "119.5",
        decimals: 6,
      },
      {
        token: "ACME",
        mint: "Issued11111111111111111111111111111111111111",
        amount: "1000000000",
        uiAmount: "1000",
        decimals: 6,
        usdPrice: 1,
      },
    ];
    renderWorkspace();

    expect(screen.getAllByText("$1,000.00").length).toBeGreaterThan(0);
    expect(screen.queryByText("$0.00")).toBeNull();
    expect(screen.queryByText("100.0%")).toBeNull();
  });

  it("never claims an empty positions list over a holding it has no record of", () => {
    // "No active vault positions" is a claim of absence like any other.
    mocks.positionsEmpty = true;
    mocks.walletBalances = [
      { token: "USDC", mint: USDC_MINT, amount: "2500000000", uiAmount: "2500", decimals: 6 },
      {
        token: "kPYUSD",
        mint: CATALOGUE_SHARE_MINT,
        amount: "7000000",
        uiAmount: "7",
        decimals: 6,
      },
    ];
    renderWorkspace();

    expect(
      screen.getByLabelText("A wallet holds vault shares with no matching position")
    ).toBeTruthy();
    expect(screen.getByText("Positions may be incomplete")).toBeTruthy();
    expect(screen.queryByText("No active vault positions")).toBeNull();
  });

  it("keeps a strategy row from printing a total another wallet contradicts", () => {
    // wallet-a's position in this vault is recorded; the reserve wallet holds
    // the same vault's shares with no row behind them, so the recorded figure
    // is a floor. The summary and that wallet's card both read unavailable, and
    // the row must not disagree with them.
    mocks.secondWalletBalances = [
      { token: "kUSDC", mint: SHARE_MINT, amount: "5000000", uiAmount: "5", decimals: 6 },
    ];
    renderWorkspace();

    const usdcRow = screen
      .getAllByText("Kamino USDC Vault")
      .map((element) => element.closest("tr"))
      .find((row) => row?.textContent?.includes("6.2%"));
    if (!usdcRow) throw new Error("Expected the USDC strategy row");
    expect(usdcRow.textContent).toContain("Live value unavailable");
    expect(usdcRow.textContent).not.toContain("125.25 USDC");
    expect(
      screen.getByLabelText("A wallet holds vault shares with no matching position")
    ).toBeTruthy();
  });

  it("says nothing it cannot witness when the wallet read fails outright", () => {
    mocks.walletsError = true;
    renderWorkspace();

    expect(screen.getByLabelText("A wallet balance could not be read")).toBeTruthy();
    expect(screen.getByLabelText("A position value could not be read")).toBeTruthy();
    expect(screen.getByText("Wallets could not be loaded. Refresh to try again.")).toBeTruthy();
    expect(screen.queryByText("$0.00")).toBeNull();
    expect(screen.queryByText("No active position")).toBeNull();
    // No bar without a share: an empty track would read as 0% deployed.
    expect(screen.queryByTestId("treasury-allocation-bar")).toBeNull();
  });

  it("never hides a cash tile because a catalogue row claims a stable mint as its share mint", () => {
    // A corrupt or mis-synced row must not make real USDC disappear while the
    // summary still counts it: the page would contradict itself about cash.
    mocks.corruptStableShareMint = true;
    renderWorkspace();

    // The tile's amount, which only the wallet card renders.
    expect(screen.getAllByText("$2,500.00").length).toBeGreaterThan(0);
  });

  it("renders no allocation bar when the split is unavailable", () => {
    mocks.livePositionTokenValue = undefined;
    renderWorkspace();

    expect(screen.queryByTestId("treasury-allocation-bar")).toBeNull();
  });

  it("renders the Figma summary trio without the legacy allocation bar", () => {
    renderWorkspace();

    expect(screen.queryByTestId("treasury-allocation-bar")).toBeNull();
    expect(screen.getByText("Deposited")).toBeTruthy();
    expect(screen.getAllByText("Available cash").length).toBeGreaterThan(0);
    expect(screen.getByText("Est. APY")).toBeTruthy();
  });

  it("treats a catalogue row with no share mint as an incomplete vocabulary", () => {
    // A row that never named its share mint contributes nothing to the
    // vocabulary, so a real vault behind it is unnameable and no deployed
    // figure can be certified.
    mocks.strategyMissingShareMint = true;
    renderWorkspace();

    expect(screen.getAllByText("$2,500.00").length).toBeGreaterThan(0);
    expect(
      screen.getByLabelText("A wallet holds vault shares with no matching position")
    ).toBeTruthy();
    expect(screen.queryByText("5.0%")).toBeNull();
  });

  it("treats a stale catalogue behind a failed revalidation as incomplete", () => {
    // SWR keeps the stale rows and sets the error. Stale means possibly
    // MISSING a newly added strategy's share mint, so no deployed figure can
    // be certified, and the strategy table already shows its error state here.
    mocks.strategiesStaleError = true;
    renderWorkspace();

    expect(screen.getAllByText("$2,500.00").length).toBeGreaterThan(0);
    expect(
      screen.getByLabelText("A wallet holds vault shares with no matching position")
    ).toBeTruthy();
    expect(screen.queryByText("5.0%")).toBeNull();
    expect(screen.queryByText("95.0%")).toBeNull();
    expect(screen.getAllByText("Live value unavailable").length).toBeGreaterThan(0);
  });

  it("keeps a deployed wallet honest when the positions read fails", () => {
    mocks.positionsError = true;
    renderWorkspace();

    // Summary side: deployed unavailable, never zero.
    expect(screen.getByLabelText("A position value could not be read")).toBeTruthy();
    // Wallet card: receipt tiles stay hidden (their mints are known from the
    // stale read), but the deployment must read unavailable, not idle.
    expect(screen.queryByText("kUSDC")).toBeNull();
    expect(screen.getByText("Deployed in vaults")).toBeTruthy();
    expect(screen.getAllByText("Live value unavailable").length).toBeGreaterThan(0);
    expect(screen.queryByText("$130.50")).toBeNull();
    expect(screen.queryByText("0.0%")).toBeNull();
  });

  it("never erases a receipt-token holding that no recorded position accounts for", () => {
    // kPYUSD's mint is known only from the strategy catalogue and has no
    // position row (deposited outside SDP), so its tile is hidden. The
    // deployment must then read unavailable rather than the recorded-only
    // total, and the summary must not claim a share of a float it cannot see
    // in full. Also pins the catalogue half of the share-mint union: drop it
    // and the tile reappears here.
    mocks.walletBalances = [
      { token: "USDC", mint: USDC_MINT, amount: "2500000000", uiAmount: "2500", decimals: 6 },
      { token: "kUSDC", mint: SHARE_MINT, amount: "119500000", uiAmount: "119.5", decimals: 6 },
      {
        token: "kPYUSD",
        mint: CATALOGUE_SHARE_MINT,
        amount: "7000000",
        uiAmount: "7",
        decimals: 6,
      },
    ];
    renderWorkspace();

    expect(screen.queryByText("kPYUSD")).toBeNull();
    expect(screen.getByText("Deployed in vaults")).toBeTruthy();
    expect(screen.getAllByText("Live value unavailable").length).toBeGreaterThan(0);
    // Every read came back here, so the caption names the real problem rather
    // than blaming a position value the table below is listing fine.
    expect(
      screen.getByLabelText("A wallet holds vault shares with no matching position")
    ).toBeTruthy();
    expect(screen.queryByLabelText("A position value could not be read")).toBeNull();
    expect(screen.queryByText("$0.00")).toBeNull();
    expect(screen.queryByText("0.0%")).toBeNull();
    expect(screen.queryByText("100.0%")).toBeNull();

    // The strategy row must not contradict them with "No active position".
    const pyusdRow = screen.getByText("Kamino PYUSD Vault").closest("tr");
    if (!pyusdRow) throw new Error("Expected the catalogue-only strategy row");
    expect(pyusdRow.textContent).toContain("Live value unavailable");
    expect(pyusdRow.textContent).not.toContain("No active position");
    expect(
      screen.getByLabelText("A wallet holds vault shares with no matching position")
    ).toBeTruthy();
  });

  it("reports every money figure as unavailable while the strategy catalogue is not", () => {
    // The catalogue is the only witness that a token with no position row is a
    // receipt, so nothing deployed can be certified without it.
    mocks.strategiesUnavailable = true;
    renderWorkspace();

    expect(screen.getAllByText("$2,500.00").length).toBeGreaterThan(0);
    expect(
      screen.getByLabelText("A wallet holds vault shares with no matching position")
    ).toBeTruthy();
    expect(screen.queryByText("5.0%")).toBeNull();
    expect(screen.queryByText("95.0%")).toBeNull();
    expect(screen.queryByText("$130.50")).toBeNull();
    // The wallet card must agree rather than showing a confident total.
    expect(screen.getAllByText("Live value unavailable").length).toBeGreaterThan(0);
  });

  it("renders the empty-float caption for a readable empty treasury", () => {
    mocks.positionsEmpty = true;
    mocks.walletBalances = [];
    renderWorkspace();

    // Readable zeros are real zeros; only the shares stay unallocated.
    expect(screen.getAllByText("$0.00").length).toBeGreaterThan(0);
    expect(screen.getByText("Est. APY")).toBeTruthy();
  });

  it("reads an unhydratable position as unavailable in the summary, never zero", () => {
    mocks.livePositionTokenValue = undefined;
    renderWorkspace();

    expect(screen.getByLabelText("A position value could not be read")).toBeTruthy();
    expect(screen.getAllByText("$2,500.00").length).toBeGreaterThan(0);
    expect(screen.queryByText("0.0%")).toBeNull();
    expect(screen.queryByText("100.0%")).toBeNull();
    // The wallet's deployed line refuses a partial total for the same reason.
    expect(screen.getAllByText("Live value unavailable").length).toBeGreaterThan(0);
    expect(screen.queryByText("$5.25")).toBeNull();
  });

  it("opens the vault exit modal from a position row", async () => {
    const user = userEvent.setup();
    renderWorkspace();

    const vaultPositionRow = screen
      .getAllByText("Kamino USDC Vault")
      .map((element) => element.closest("tr"))
      .find((row) => row && within(row).queryByRole("button", { name: "Withdraw" }));
    if (!vaultPositionRow) throw new Error("Expected vault position row");

    await user.click(within(vaultPositionRow).getByRole("button", { name: "Withdraw" }));
    expect(screen.getByRole("dialog").textContent).toBe("Withdraw from Kamino USDC Vault");
  });

  it("keeps the vault exit verb live in production, where deposits are closed", () => {
    // ADR 0002: the environment fail-close guards the way IN only. A position
    // that exists in production must keep its way out.
    mocks.environment = "production";
    renderWorkspace();

    const vaultPositionRow = screen
      .getAllByText("Kamino USDC Vault")
      .map((element) => element.closest("tr"))
      .find((row) => row && within(row).queryByRole("button", { name: "Withdraw" }));
    if (!vaultPositionRow) throw new Error("Expected vault position row");
    expect(
      (within(vaultPositionRow).getByRole("button", { name: "Withdraw" }) as HTMLButtonElement)
        .disabled
    ).toBe(false);
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
    expect(screen.getByLabelText(/intentionally closed in production/)).toBeTruthy();
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

  it("recovers every in-flight vault withdrawal from the server ledger", async () => {
    mocks.vaultWithdrawals = [
      { movementId: "earn_movement_requested", status: "requested" },
      { movementId: "earn_movement_submitted", status: "submitted" },
      // The unified ledger's vocabulary: `confirmed` is optimistic commitment,
      // NOT terminal — a fork can still drop it, so it stays watched.
      { movementId: "earn_movement_confirmed", status: "confirmed" },
      // A repeated ledger result must still mount only one keyed tracker.
      { movementId: "earn_movement_confirmed", status: "confirmed" },
      { movementId: "earn_movement_finalized", status: "finalized" },
      { movementId: "earn_movement_failed", status: "failed" },
    ];

    renderWorkspace();

    await waitFor(() => {
      expect(screen.getAllByTestId("vault-withdrawal-outcome-tracker")).toHaveLength(3);
    });
    expect(
      screen
        .getAllByTestId("vault-withdrawal-outcome-tracker")
        .map((tracker) => tracker.textContent)
        .sort()
    ).toEqual(["earn_movement_confirmed", "earn_movement_requested", "earn_movement_submitted"]);
    expect(document.body.textContent).not.toContain("earn_movement_finalized");
    expect(document.body.textContent).not.toContain("earn_movement_failed");
  });

  it("keeps recovered vault trackers mounted until their detail poll settles", async () => {
    mocks.vaultDeposits = [{ movementId: "earn_deposit_recovered", status: "submitted" }];
    mocks.vaultWithdrawals = [{ movementId: "earn_withdrawal_recovered", status: "confirmed" }];
    const view = renderWorkspace();

    await waitFor(() => {
      expect(screen.getByText("earn_deposit_recovered")).toBeTruthy();
      expect(screen.getByText("earn_withdrawal_recovered")).toBeTruthy();
    });

    // A collection refresh can stop returning an id before the independent
    // detail poll sees terminal state. The persisted watches must survive it.
    mocks.vaultDeposits = [];
    mocks.vaultWithdrawals = [];
    view.rerender(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <TreasurySolutionsWorkspace
          providerAccess={{ kamino: { entitled: true, configured: true, enabled: true } }}
        />
      </I18nProvider>
    );

    expect(screen.getByText("earn_deposit_recovered")).toBeTruthy();
    expect(screen.getByText("earn_withdrawal_recovered")).toBeTruthy();
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

describe("TreasurySolutionsWorkspace — catalogue cluster toggle (PRO-1742)", () => {
  it("browses the mirrored mainnet shelf behind the toggle, naming the cluster on the row", async () => {
    const user = userEvent.setup();
    renderWorkspace();

    // Default view: the environment's own shelf, no opt-in sent to the seam.
    expect(screen.getAllByText("Kamino USDC Vault").length).toBeGreaterThan(0);
    expect(mocks.strategiesClusterRequests).not.toContain("mainnet-beta");

    const toggle = screen.getByLabelText("Catalogue cluster");
    await user.click(within(toggle).getByRole("button", { name: "Mainnet" }));

    // The card re-reads with the explicit opt-in…
    expect(mocks.strategiesClusterRequests).toContain("mainnet-beta");

    // …and the mirrored row renders its Deposit disabled with the cluster
    // named as the reason — never the bare "Unavailable" collapse.
    const row = screen.getByText("Kamino JLP Vault").closest("tr");
    expect(row).not.toBeNull();
    const cells = within(row as HTMLTableRowElement);
    expect(cells.getByText("Mainnet only")).toBeTruthy();
    expect(cells.queryByText("Unavailable")).toBeNull();
    const deposit = cells.getByRole("button", { name: "Deposit" });
    expect(deposit.hasAttribute("disabled")).toBe(true);
  });

  it("renders no cluster toggle in production — there is no other shelf to offer", () => {
    mocks.environment = "production";
    renderWorkspace();

    expect(screen.queryByLabelText("Catalogue cluster")).toBeNull();
    expect(screen.queryByText("Devnet")).toBeNull();
    // Production reads its default shelf; the opt-in never reaches the seam.
    expect(mocks.strategiesClusterRequests).not.toContain("mainnet-beta");
  });

  it("normalizes toggling back to the environment's own cluster into the shared default key", async () => {
    // Selecting Devnet after Mainnet must re-join the environment-default SWR
    // key (cluster: undefined) rather than pinning a second, permanently
    // distinct cache entry of the identical shelf under the literal "devnet".
    const user = userEvent.setup();
    renderWorkspace();

    const toggle = screen.getByLabelText("Catalogue cluster");
    await user.click(within(toggle).getByRole("button", { name: "Mainnet" }));
    expect(mocks.strategiesClusterRequests).toContain("mainnet-beta");

    await user.click(within(toggle).getByRole("button", { name: "Devnet" }));
    expect(screen.getAllByText("Kamino USDC Vault").length).toBeGreaterThan(0);
    expect(mocks.strategiesClusterRequests).not.toContain("devnet");
  });

  it("refreshes the shared default shelf ONCE per click, and the mirror separately once toggled", async () => {
    const user = userEvent.setup();
    renderWorkspace();

    // On the default shelf both strategy hooks share one SWR key: one click,
    // one revalidation of it (the paged fetch must not run twice).
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(mocks.refreshStrategies).toHaveBeenCalledTimes(1);

    // Once the toggle leaves the default, the mirror shelf is a second key and
    // earns its own refresh.
    const toggle = screen.getByLabelText("Catalogue cluster");
    await user.click(within(toggle).getByRole("button", { name: "Mainnet" }));
    mocks.refreshStrategies.mockClear();
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(mocks.refreshStrategies).toHaveBeenCalledTimes(2);
  });
});
