// @vitest-environment jsdom

import type { EarnVaultPosition } from "@sdp/types/earn";
import type { Operation } from "@sdp/types/operations";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useEffectEvent } from "react";
import { SWRConfig, useSWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EarnWithdrawalRecovery } from "@/app/(session)/dashboard/[projectId]/markets/earn/earn-core-operations";
import { earnQueryKeys } from "@/app/(session)/dashboard/[projectId]/markets/earn/earn-query-key";
import {
  type EarnProviderAccess,
  SURFACED_VAULT_DIRECT_EARN_PROVIDERS,
} from "@/app/(session)/dashboard/[projectId]/markets/earn/earn-surfacing";
import { EnglishTestI18n } from "@/app/(session)/dashboard/[projectId]/markets/test-i18n";
import {
  earnCoreClient,
  isEarnOperationTerminal,
  useEarnOperation,
  useEarnOperations,
} from "@/lib/earn-core-data";
import * as kaminoAllocations from "./kamino-allocations";
import type { KaminoVaultAllocations } from "./kamino-allocations-schema";
import { TREASURY_WALLETS_BODY } from "./treasury-layout";
import {
  EarnTransactionModalLoading,
  TreasurySolutionsWorkspace,
} from "./treasury-solutions-workspace";

// jsdom implements no matchMedia, while the workspace's motion components read
// it through useReducedMotion.
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
  canManageCustody: true,
  canWrite: true,
  environment: "sandbox" as "sandbox" | "production",
  // Every cluster value useEarnStrategies was asked for, across renders.
  strategiesClusterRequests: [] as Array<"devnet" | "mainnet-beta" | undefined>,
  refreshStrategies: vi.fn(),
  refreshPositions: vi.fn(),
  positionsAfterMovementIds: [] as string[],
  refreshWalletBalances: vi.fn(),
  refreshWallets: vi.fn(),
  coreAction: undefined as
    | {
        kind: "deposit" | "withdraw";
        intermediate?: boolean;
        defaultWithdrawAll?: boolean;
        onClose: () => void;
        onUpdated?: (operation: Operation) => void;
      }
    | undefined,
  coreFeed: undefined as
    | {
        onUpdated: (operation: Operation) => void;
        withdrawalRecovery?: EarnWithdrawalRecovery<EarnVaultPosition>;
      }
    | undefined,
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
  // Far in the past, so the read predates any movement a test submits.
  positionsReadStartedAt: 1_000,
  positionsReadLandedAt: 1_000,
  livePositionShares: "119.5",
  exitedPositionParIntermediate: undefined as
    | { mint: string; amount: string; withdrawableAmount: string; tokenValue: string }
    | undefined,
  positionsError: false,
  positionsEmpty: false,
  strategiesLoading: false,
  strategiesUnavailable: false,
  strategiesStaleError: false,
  mainnetStrategiesLoading: false,
  mainnetStrategiesUnavailable: false,
  strategyMissingShareMint: false,
  walletsError: false,
  walletsEmpty: false,
  corruptStableShareMint: false,
  secondWalletBalances: undefined as
    | Array<{ token: string; mint: string; amount: string; uiAmount: string; decimals: number }>
    | undefined,
  // Vault address -> "loading" | "error" | a Kamino allocations payload.
  allocationsByVault: {} as Record<string, "loading" | "error" | KaminoVaultAllocations>,
  // Real SWR keeps the last read beside a later error.
  allocationsFailAfterRead: false,
  allocationsRequests: [] as Array<string | undefined>,
}));

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SHARE_MINT = "Share1111111111111111111111111111111111111";
// A share mint known only through the strategy catalogue — no position row.
const CATALOGUE_SHARE_MINT = "ShareCatalogue11111111111111111111111111111";

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({ sdpEnvironment: mocks.environment }),
  useCanWrite: () => mocks.canWrite,
  useOptionalDashboardWorkspace: () => ({
    dashboardAccess: { capabilities: { canManageCustody: mocks.canManageCustody } },
    flags: { custody: true },
  }),
}));

vi.mock("@/app/(session)/dashboard/[projectId]/markets/earn/deposit/earn-funding-wallets", () => ({
  useEarnFundingWallets: () => ({
    error: mocks.walletsError ? new Error("wallets unavailable") : undefined,
    isLoading: false,
    refreshBalances: mocks.refreshWalletBalances,
    refresh: mocks.refreshWallets,
    wallets: mocks.walletsEmpty
      ? []
      : [
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

vi.mock("@/app/(session)/dashboard/[projectId]/markets/earn/earn-data", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/app/(session)/dashboard/[projectId]/markets/earn/earn-data")
  >()),
  useEarnStrategies: (options?: { cluster?: "devnet" | "mainnet-beta" }) => {
    mocks.strategiesClusterRequests.push(options?.cluster);
    // The mirrored mainnet shelf (PRO-1742) is the sandbox catalogue's base
    // list. Rows arrive `fundable: false`, exactly as the API derives them.
    if (options?.cluster === "mainnet-beta") {
      const mainnetUnavailable =
        mocks.mainnetStrategiesUnavailable || mocks.mainnetStrategiesLoading;
      return {
        error: mocks.mainnetStrategiesUnavailable
          ? new Error("mainnet catalogue unavailable")
          : undefined,
        isLoading: mocks.mainnetStrategiesLoading,
        refresh: mocks.refreshStrategies,
        strategies: mainnetUnavailable
          ? undefined
          : [
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
                riskMetadata: { tvlUsd: 32_000_000 },
                liquidityTerm: "instant",
                status: "active",
                hostCluster: "mainnet-beta",
                fundable: false,
                createdAt: "2026-08-18T00:00:00.000Z",
                updatedAt: "2026-08-18T00:00:00.000Z",
              },
              // The mainnet counterparts the intersection filter demands: the
              // devnet rows may only advertise names this shelf actually
              // offers, from the same provider. RockawayX is deliberately
              // absent — the devnet vault mapping to it must stay hidden.
              {
                id: "earn_strategy_mainnet_steakhouse",
                provider: "kamino",
                providerReference: "KvaultMainnetSteakhouse1111111111111111111",
                name: "Steakhouse USDC",
                sourceKind: "defi",
                depositMints: [USDC_MINT],
                shareMint: "ShareMainnetSteakhouse111111111111111111111",
                apyType: "variable",
                currentApy: "0.058",
                riskMetadata: { tvlUsd: 40_000_000 },
                liquidityTerm: "instant",
                status: "active",
                hostCluster: "mainnet-beta",
                fundable: false,
                createdAt: "2026-08-18T00:00:00.000Z",
                updatedAt: "2026-08-18T00:00:00.000Z",
              },
              {
                id: "earn_strategy_mainnet_allez",
                provider: "kamino",
                providerReference: "KvaultMainnetAllez1111111111111111111111",
                name: "Allez USDC",
                sourceKind: "defi",
                depositMints: [USDC_MINT],
                shareMint: "ShareMainnetAllez111111111111111111111111",
                apyType: "variable",
                currentApy: "0.045",
                riskMetadata: { tvlUsd: 18_000_000 },
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
    const strategiesUnavailable = mocks.strategiesUnavailable || mocks.strategiesLoading;
    return {
      error:
        mocks.strategiesUnavailable || mocks.strategiesStaleError
          ? new Error("catalogue unavailable")
          : undefined,
      isLoading: mocks.strategiesLoading,
      refresh: mocks.refreshStrategies,
      strategies: strategiesUnavailable
        ? undefined
        : [
            {
              id: "earn_strategy_live",
              provider: "kamino",
              providerReference: "Kvault11111111111111111111111111111111111",
              name: "Steakhouse USDC",
              sourceKind: "defi",
              depositMints: [USDC_MINT],
              shareMint: SHARE_MINT,
              apyType: "variable",
              currentApy: "0.062",
              riskMetadata: { tvlUsd: 12_345_678.9 },
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
              name: "Allez USDC",
              sourceKind: "defi",
              depositMints: [USDC_MINT],
              ...(mocks.strategyMissingShareMint
                ? {}
                : { shareMint: mocks.corruptStableShareMint ? USDC_MINT : CATALOGUE_SHARE_MINT }),
              apyType: "variable",
              currentApy: "0.041",
              riskMetadata: { tvlUsd: 25_000_000 },
              liquidityTerm: "instant",
              status: "active",
              hostCluster: "devnet",
              fundable: true,
              createdAt: "2026-08-18T00:00:00.000Z",
              updatedAt: "2026-08-18T00:00:00.000Z",
            },
            // A devnet vault with NO mainnet counterpart: the Sandbox shelf
            // hides it (the rough-name intersection), so nothing below may
            // treat it as rendered.
            {
              id: "earn_strategy_devnet_only",
              provider: "kamino",
              providerReference: "KvaultDevnetOnly11111111111111111111111111",
              name: "Kamino Vault USDC",
              sourceKind: "defi",
              depositMints: [USDC_MINT],
              shareMint: "ShareDevnetOnly111111111111111111111111111",
              apyType: "variable",
              currentApy: "0.055",
              riskMetadata: { tvlUsd: 5_000_000 },
              liquidityTerm: "instant",
              status: "active",
              hostCluster: "devnet",
              fundable: true,
              createdAt: "2026-08-18T00:00:00.000Z",
              updatedAt: "2026-08-18T00:00:00.000Z",
            },
            // A mapped name whose mainnet counterpart the loaded mainnet shelf
            // never lists: the catalogue check must veto the mapping, so this
            // row stays off the Sandbox shelf too (the RockawayX case).
            {
              id: "earn_strategy_rockaway_devnet",
              provider: "kamino",
              providerReference: "KvaultRockaway11111111111111111111111111",
              name: "RockawayX RWA USDC",
              sourceKind: "defi",
              depositMints: [USDC_MINT],
              shareMint: "ShareRockaway111111111111111111111111111111",
              apyType: "variable",
              currentApy: "0.048",
              riskMetadata: { tvlUsd: 8_000_000 },
              liquidityTerm: "instant",
              status: "active",
              hostCluster: "devnet",
              fundable: true,
              createdAt: "2026-08-18T00:00:00.000Z",
              updatedAt: "2026-08-18T00:00:00.000Z",
            },
            // A delayed-liquidity fund with no observed APY yet: liquidity must
            // name its redemption delay and the APY cell must stay a
            // placeholder, never a fabricated rate.
            {
              id: "earn_strategy_delayed_fund",
              provider: "veda",
              providerReference: "VedaFund1111111111111111111111111111111111",
              name: "Veda Treasury Fund",
              sourceKind: "rwa",
              depositMints: [USDC_MINT],
              shareMint: "ShareDelayed11111111111111111111111111111111",
              apyType: "fixed",
              liquidityTerm: "delayed",
              redemptionDelayDays: 7,
              status: "active",
              hostCluster: "devnet",
              fundable: true,
              createdAt: "2026-08-18T00:00:00.000Z",
              updatedAt: "2026-08-18T00:00:00.000Z",
            },
          ],
    };
  },
  useEarnVaultPositions: () => {
    const exited = {
      id: "earn_vault_position_exited",
      provider: "kamino",
      providerReference: "KvaultExited1111111111111111111111111111111",
      label: "Exited provider vault",
      custodyWalletId: "cwlt_live",
      tokenMint: USDC_MINT,
      shareMint: "ShareExited11111111111111111111111111111111",
      createdAt: "2026-08-16T00:00:00.000Z",
      closedAt: null,
      feeSponsored: false,
      shares: "0",
      tokenValue: "0",
    };
    const positions = mocks.positionsEmpty
      ? []
      : [
          {
            id: "earn_vault_position_live",
            provider: "kamino",
            providerReference: "Kvault11111111111111111111111111111111111",
            label: "Steakhouse USDC",
            custodyWalletId: "cwlt_live",
            tokenMint: USDC_MINT,
            shareMint: SHARE_MINT,
            createdAt: "2026-08-18T00:00:00.000Z",
            closedAt: null,
            feeSponsored: false,
            shares: mocks.livePositionShares,
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
            feeSponsored: false,
            shares: "5",
            tokenValue: "5.25",
          },
          mocks.exitedPositionParIntermediate
            ? { ...exited, parIntermediate: mocks.exitedPositionParIntermediate }
            : exited,
        ];
    return {
      // Real SWR keeps stale data alongside an error; the workspace guard is
      // what must refuse to render it as live.
      error: mocks.positionsError ? new Error("positions unavailable") : undefined,
      isLoading: false,
      // The mutation resolves with a real read envelope; tests independently
      // advance the rendered cache to exercise the render/refresh boundary.
      refresh: (movementIds?: readonly string[]) => {
        mocks.refreshPositions(movementIds);
        return Promise.resolve({
          positions,
          startedAt: mocks.positionsReadStartedAt,
          landedAt: mocks.positionsReadLandedAt,
          afterMovementIds: movementIds,
          minimumSlot: movementIds?.length ? 101 : undefined,
        });
      },
      positions,
      // One read whose contents follow the mocks; a test moves its clock and
      // shares to stand for the next read landing.
      reads: [
        {
          startedAt: mocks.positionsReadStartedAt,
          landedAt: mocks.positionsReadLandedAt,
          afterMovementIds: mocks.positionsAfterMovementIds,
          positions,
        },
      ],
    };
  },
}));

vi.mock("@/app/(session)/dashboard/[projectId]/markets/earn/earn-core-action-modal", () => ({
  EarnCoreActionModal: (props: {
    kind: "deposit" | "withdraw";
    intermediate?: boolean;
    defaultWithdrawAll?: boolean;
    strategy?: { name: string };
    position?: { label: string };
    onClose: () => void;
    onUpdated?: (operation: Operation) => void;
  }) => {
    mocks.coreAction = props;
    return (
      <div role="dialog">
        {props.kind === "deposit"
          ? `Deposit into ${props.strategy?.name}`
          : `Withdraw from ${props.position?.label}`}
      </div>
    );
  },
}));
vi.mock("@/app/(session)/dashboard/[projectId]/markets/earn/earn-core-operations", () => ({
  EarnCoreOperations: (props: {
    onUpdated: (operation: Operation) => void;
    withdrawalRecovery?: EarnWithdrawalRecovery<EarnVaultPosition>;
  }) => {
    mocks.coreFeed = props;
    return null;
  },
}));

function coreOperation(status: Operation["status"]): Operation {
  return {
    id: "core-operation",
    kind: "earn.deposit",
    status,
    environment: "sandbox",
    intent: {
      kind: "earn.deposit",
      strategyId: "strategy",
      source: { walletId: "cwlt_live" },
      amount: { mint: USDC_MINT, value: "100" },
    },
    actionId: "action",
    version: 1,
    nextAction:
      status === "completed" ? null : { type: "wait", reason: "Waiting for confirmation" },
    terms: { expiresAt: null, estimate: null, minimum: null, fees: null, options: [] },
    buildRef: null,
    resourceRef: { kind: "earn.movement", id: "core-movement" },
    result: {
      positionId: "earn_vault_position_live",
      signature: "signature",
      source: { walletId: "cwlt_live" },
      settledAmount: null,
      settlementOutcome: null,
    },
    error: null,
    canCancel: false,
    cancelRequestedAt: null,
    createdAt: "2026-11-18T00:00:00Z",
    updatedAt: "2026-11-18T00:00:00Z",
  };
}

// A fresh element per call: React bails out of re-rendering a subtree handed
// the identical element instance, which would leave the mocked hooks unread.
const workspaceElement = () => (
  <EnglishTestI18n>
    <TreasurySolutionsWorkspace
      providerAccess={{
        kamino: { entitled: true, configured: true, enabled: true },
      }}
    />
  </EnglishTestI18n>
);

function LiveOperationDetail({ operation }: { operation: Operation }) {
  useEarnOperation(operation.id, operation, (updated) => mocks.coreFeed?.onUpdated(updated));
  return null;
}

function LiveOperationsFeed({
  operationId,
  onPollReady,
}: {
  operationId: string;
  onPollReady: (poll: () => Promise<unknown>) => void;
}) {
  const { operations } = useEarnOperations();
  const { mutate } = useSWRConfig();
  const reportPollReady = useEffectEvent(onPollReady);
  useEffect(() => {
    reportPollReady(() => mutate(earnQueryKeys.operations()));
  }, [mutate]);
  const operation = operations?.find(({ id }) => id === operationId);
  return (
    <>
      <p data-testid="observed-exit">{operation?.status ?? "absent"}</p>
      {operation && !isEarnOperationTerminal(operation) ? (
        <LiveOperationDetail operation={operation} />
      ) : null}
    </>
  );
}

function renderWorkspace() {
  return render(workspaceElement());
}

/** The summary's hero figure: what is deposited across open positions. */
function summaryFigure(): string | undefined {
  const label = within(document.body).getByRole("heading", { name: "Deposited" });
  return label.nextElementSibling?.textContent ?? undefined;
}

/** The Active positions row for the recorded live position. */
function livePositionRow(): HTMLTableRowElement {
  const row = screen
    .getAllByText("Steakhouse USDC")
    .map((element) => element.closest("tr"))
    .find(
      (candidate) => candidate && within(candidate).queryByRole("button", { name: "Withdraw" })
    );
  if (!row) throw new Error("Expected position row");
  return row;
}

// The devnet strategy rows carry the cluster badge, and a name can exist on
// both shelves once the intersection filter is satisfied — the badge is what
// distinguishes the depositable devnet row from its mainnet mirror.
const devnetStrategyRow = (name: string) =>
  screen
    .queryAllByText(name)
    .map((element) => element.closest("tr"))
    .find((row) => row?.textContent?.includes("Devnet"));

beforeEach(() => {
  mocks.canWrite = true;
  mocks.positionsAfterMovementIds = [];
  mocks.canManageCustody = true;
  mocks.environment = "sandbox";
  mocks.strategiesClusterRequests = [];
  mocks.coreAction = undefined;
  mocks.coreFeed = undefined;
  mocks.walletBalances = [
    { token: "USDC", mint: USDC_MINT, amount: "2500000000", uiAmount: "2500", decimals: 6 },
    // The vault receipt token the custody wallet actually holds on chain, for
    // a position that IS recorded. It must render as vault ownership, never as
    // a token tile.
    { token: "kUSDC", mint: SHARE_MINT, amount: "119500000", uiAmount: "119.5", decimals: 6 },
  ];
  mocks.livePositionTokenValue = "125.25";
  mocks.positionsReadStartedAt = 1_000;
  mocks.positionsReadLandedAt = 1_000;
  mocks.livePositionShares = "119.5";
  mocks.exitedPositionParIntermediate = undefined;
  mocks.positionsError = false;
  mocks.positionsEmpty = false;
  mocks.strategiesLoading = false;
  mocks.strategiesUnavailable = false;
  mocks.strategiesStaleError = false;
  mocks.mainnetStrategiesLoading = false;
  mocks.mainnetStrategiesUnavailable = false;
  mocks.secondWalletBalances = undefined;
  mocks.strategyMissingShareMint = false;
  mocks.walletsError = false;
  mocks.walletsEmpty = false;
  mocks.corruptStableShareMint = false;
  mocks.allocationsByVault = {};
  mocks.allocationsFailAfterRead = false;
  mocks.allocationsRequests = [];
  vi.clearAllMocks();
  // Mirrors the read's contract: one read for the table's mainnet Kamino vaults,
  // none at all without one, and a vault whose read failed is absent from it.
  vi.spyOn(kaminoAllocations, "useKaminoVaultAllocations").mockImplementation((vaults) => {
    mocks.allocationsRequests.push(...vaults);
    if (vaults.length === 0) {
      return { allocationsByVault: undefined, error: undefined, isLoading: false };
    }
    if (vaults.some((vault) => mocks.allocationsByVault[vault] === "loading")) {
      return { allocationsByVault: undefined, error: undefined, isLoading: true };
    }
    const allocationsByVault: Record<string, KaminoVaultAllocations> = {};
    for (const vault of vaults) {
      const state = mocks.allocationsByVault[vault];
      if (state !== undefined && state !== "loading" && state !== "error") {
        allocationsByVault[vault] = state;
      }
    }
    return {
      allocationsByVault,
      error: mocks.allocationsFailAfterRead ? new Error("refresh failed") : undefined,
      isLoading: false,
    };
  });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("TreasurySolutionsWorkspace", () => {
  it("waits for an operation outcome before refreshing balances", async () => {
    renderWorkspace();
    act(() => mocks.coreFeed?.onUpdated(coreOperation("submitted")));
    expect(mocks.refreshPositions).not.toHaveBeenCalled();
    expect(mocks.refreshWalletBalances).not.toHaveBeenCalled();
    expect(within(livePositionRow()).getByText("$125.25")).toBeTruthy();
    await act(async () => mocks.coreFeed?.onUpdated(coreOperation("completed")));
    expect(mocks.refreshPositions).toHaveBeenCalledWith(["core-movement"]);
    expect(mocks.refreshWalletBalances).toHaveBeenCalledWith(101, ["cwlt_live"]);
    expect(screen.queryByText("$225.25")).toBeNull();
    await act(async () => mocks.coreFeed?.onUpdated(coreOperation("completed")));
    expect(mocks.refreshPositions).toHaveBeenCalledTimes(1);
  });

  it("refreshes holdings and cash when a delayed operation outcome changes", async () => {
    renderWorkspace();
    const operation = coreOperation("settling");
    operation.resourceRef = { kind: "earn.withdrawal_request", id: "queued-request" };
    await act(async () => mocks.coreFeed?.onUpdated(operation));
    expect(mocks.refreshPositions).toHaveBeenCalledTimes(1);
    expect(mocks.refreshWalletBalances).toHaveBeenCalledTimes(1);
    expect(mocks.refreshStrategies).not.toHaveBeenCalled();
  });

  it("refreshes queue balances at escrow confirmation, not submission or heartbeat", async () => {
    renderWorkspace();
    const submitted = coreOperation("submitted");
    submitted.resourceRef = { kind: "earn.withdrawal_request", id: "queued-request" };
    await act(async () => mocks.coreFeed?.onUpdated(submitted));
    await act(async () =>
      mocks.coreFeed?.onUpdated({ ...submitted, updatedAt: "2026-11-18T00:00:15Z" })
    );
    expect(mocks.refreshPositions).not.toHaveBeenCalled();
    expect(mocks.refreshWalletBalances).not.toHaveBeenCalled();
    const settling = {
      ...submitted,
      status: "settling" as const,
      updatedAt: "2026-11-18T00:00:30Z",
    };
    await act(async () => mocks.coreFeed?.onUpdated(settling));
    await act(async () =>
      mocks.coreFeed?.onUpdated({ ...settling, updatedAt: "2026-11-18T00:00:45Z" })
    );
    expect(mocks.refreshPositions).toHaveBeenCalledTimes(1);
    expect(mocks.refreshWalletBalances).toHaveBeenCalledTimes(1);
  });

  it("refreshes returned escrow shares without treating recovery as withdrawal proceeds", async () => {
    renderWorkspace();
    const operation = coreOperation("completed");
    operation.kind = "earn.withdraw";
    operation.intent = {
      kind: "earn.withdraw",
      positionId: "earn_vault_position_live",
      amount: { kind: "all" },
    };
    operation.resourceRef = { kind: "earn.withdrawal_recovery", id: "recovery" };
    if (operation.result) {
      operation.result.settlementOutcome = "recovered";
      operation.result.settledAmount = { mint: SHARE_MINT, value: "10" };
    }
    await act(async () => mocks.coreFeed?.onUpdated(operation));
    expect(mocks.refreshPositions).toHaveBeenCalledTimes(1);
    expect(mocks.refreshWalletBalances).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("$10.00")).toBeNull();
  });

  it("does not reread holdings or cash for a provider heartbeat", async () => {
    renderWorkspace();
    const operation = coreOperation("settling");
    operation.resourceRef = { kind: "earn.withdrawal_request", id: "queued-request" };
    await act(async () => mocks.coreFeed?.onUpdated(operation));
    await act(async () =>
      mocks.coreFeed?.onUpdated({ ...operation, updatedAt: "2026-11-18T00:00:15Z" })
    );
    expect(mocks.refreshPositions).toHaveBeenCalledTimes(1);
    expect(mocks.refreshWalletBalances).toHaveBeenCalledTimes(1);
    await act(async () =>
      mocks.coreFeed?.onUpdated({
        ...operation,
        status: "completed",
        updatedAt: "2026-11-18T00:00:30Z",
      })
    );
    expect(mocks.refreshPositions).toHaveBeenCalledTimes(2);
    expect(mocks.refreshWalletBalances).toHaveBeenCalledTimes(2);
  });

  it("publishes an old exit's detail completion into the real feed and refreshes its exact wallet", async () => {
    const pending = { ...coreOperation("settling"), createdAt: "2026-11-17T00:00:00Z" };
    const recent = Array.from({ length: 50 }, (_, index) => ({
      ...coreOperation("completed"),
      id: `recent-${index}`,
    }));
    let activeReads = 0;
    const list = vi.spyOn(earnCoreClient, "operations").mockImplementation(async (query) => ({
      operations: query?.status === "active" ? (++activeReads === 1 ? [pending] : []) : recent,
      nextCursor: null,
    }));
    let finish: ((value: Operation) => void) | undefined;
    const response = new Promise<Operation>((resolve) => {
      finish = resolve;
    });
    const detail = vi.spyOn(earnCoreClient, "operation").mockReturnValue(response);
    let poll: () => Promise<unknown> = async () => undefined;
    const cache = new Map();
    try {
      render(
        <SWRConfig value={{ provider: () => cache, dedupingInterval: 0 }}>
          {workspaceElement()}
          <LiveOperationsFeed
            operationId={pending.id}
            onPollReady={(read) => {
              poll = read;
            }}
          />
        </SWRConfig>
      );
      await waitFor(() => expect(detail).toHaveBeenCalledTimes(1));
      await act(() => poll());
      expect(screen.getByTestId("observed-exit").textContent).toBe("settling");
      await act(async () => {
        finish?.(coreOperation("completed"));
        await response;
      });
      await waitFor(() =>
        expect(screen.getByTestId("observed-exit").textContent).toBe("completed")
      );
      expect(mocks.refreshPositions).toHaveBeenCalledExactlyOnceWith(["core-movement"]);
      expect(mocks.refreshWalletBalances).toHaveBeenCalledExactlyOnceWith(101, ["cwlt_live"]);
      await act(() => poll());
      expect(screen.getByTestId("observed-exit").textContent).toBe("absent");
    } finally {
      list.mockRestore();
      detail.mockRestore();
    }
  });

  it("shows immediate feedback while a deferred transaction modal loads", () => {
    render(
      <EnglishTestI18n>
        <EarnTransactionModalLoading />
      </EnglishTestI18n>
    );

    expect(screen.getByRole("dialog", { name: "Loading…" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Loading…");
  });

  it("guides a treasury with no wallet straight into wallet setup", () => {
    mocks.walletsEmpty = true;
    mocks.positionsEmpty = true;
    renderWorkspace();

    expect(screen.getByText("No custody wallets yet")).toBeTruthy();
    const action = screen.getByRole("link", { name: "Create wallet" });
    expect(action.getAttribute("href")).toBe("/dashboard/prj_test_sandbox/wallets/setup");
    expect(screen.queryByRole("link", { name: "View all" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Available strategies" })).toBeTruthy();
  });

  it("does not offer wallet setup without custody management permission", () => {
    mocks.canManageCustody = false;
    mocks.walletsEmpty = true;
    mocks.positionsEmpty = true;
    renderWorkspace();

    expect(screen.getByText("No custody wallets yet")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Create wallet" })).toBeNull();
  });

  it("renders live wallets, positions and the strategy catalogue", async () => {
    const user = userEvent.setup();
    renderWorkspace();

    expect(screen.getAllByText("Operating treasury").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$2,500.00").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "Custody wallets" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Active positions" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Available strategies" })).toBeTruthy();

    const vaultRows = screen
      .getAllByText("Steakhouse USDC")
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
    expect(within(vaultStrategyRow).queryByText("Available")).toBeNull();

    const activePositionsTable = vaultPositionRow.closest("table");
    if (!activePositionsTable) throw new Error("Expected the active positions table");
    expect(
      within(activePositionsTable)
        .getAllByRole("columnheader")
        .map((header) => header.textContent)
    ).toEqual(["Position", "Wallet", "Status", "Balance", "Actions"]);
    // Status reads as words in its tone, not a pill: in its column, and under the balance on a
    // phone, where the column drops out.
    const statusWords = within(vaultPositionRow).getAllByText("Active");
    expect(statusWords).toHaveLength(2);
    for (const word of statusWords) expect(word.className).toContain("text-success");
    expect(
      statusWords.some((word) => word.closest("td")?.querySelector("[data-earn-vault-balance]"))
    ).toBe(true);

    // PRO-1723: the allocation summary totals the float above the tables.
    expect(screen.getByText("Deposited")).toBeTruthy();
    expect(screen.getAllByText("Available cash").length).toBeGreaterThan(0);
    expect(screen.getByText("est. APY")).toBeTruthy();
    expect(summaryFigure()).toBe("$130.50");

    // Vault ownership renders as the wallet's deployed line, never as a
    // receipt-token tile or a raw share count.
    expect(screen.queryByText("kUSDC")).toBeNull();
    expect(screen.queryByText("119.5")).toBeNull();
    expect(screen.getAllByText("Deployed").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$130.50").length).toBeGreaterThan(0);
    expect(screen.getByText("Retired provider vault")).toBeTruthy();
    expect(screen.queryByText("Exited provider vault")).toBeNull();

    // The exit verb is LIVE (PRO-1702) and takes no availability gate: money
    // out beats money off, so it stays enabled even where deposits are not.
    const vaultWithdraw = within(vaultPositionRow).getByRole("button", { name: "Withdraw" });
    expect((vaultWithdraw as HTMLButtonElement).disabled).toBe(false);

    await user.click(within(vaultStrategyRow).getByRole("button", { name: "Deposit" }));
    expect(screen.getByRole("dialog").textContent).toBe("Deposit into Steakhouse USDC");
  });

  it("shows a read-only member every holding and no money action", () => {
    // The API refuses a viewer's writes, so no money action is offered.
    mocks.canWrite = false;
    renderWorkspace();

    expect(screen.getAllByText("Steakhouse USDC").length).toBeGreaterThan(0);
    expect(summaryFigure()).toBe("$130.50");
    expect(screen.queryByRole("button", { name: "Deposit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Withdraw" })).toBeNull();
    expect(mocks.coreFeed?.withdrawalRecovery).toBeUndefined();
  });

  it("keeps a position its par intermediate still funds and offers only its par redemption", async () => {
    mocks.exitedPositionParIntermediate = {
      mint: "wYLDS111111111111111111111111111111111111111",
      amount: "2000",
      withdrawableAmount: "2000",
      tokenValue: "2000",
    };
    renderWorkspace();

    const residualRow = screen
      .getAllByText("Exited provider vault")
      .map((element) => element.closest("tr"))
      .find((row) => row?.querySelector("[data-earn-vault-par-intermediate]"));
    if (!residualRow) throw new Error("Expected the residual position row");
    expect(residualRow.querySelector("[data-earn-vault-par-intermediate]")?.textContent).toBe(
      "Includes 2,000 wYLDS"
    );
    expect(residualRow.querySelector("[data-earn-vault-balance-value]")?.textContent).toBe(
      "$2,000.00"
    );
    expect(within(residualRow).queryByRole("button", { name: "Withdraw" })).toBeNull();
    expect(summaryFigure()).toBe("$2,130.50");
    // The row still offers its own exit, so the activity feed offers no recovery for it.
    expect(mocks.coreFeed?.withdrawalRecovery?.positions).toEqual([]);

    await userEvent
      .setup()
      .click(within(residualRow).getByRole("button", { name: "Redeem wYLDS" }));
    expect(screen.getByRole("dialog").textContent).toBe("Withdraw from Exited provider vault");
    expect(mocks.coreAction?.intermediate).toBe(true);
  });

  it("renders lean strategy columns with the provider under each strategy", () => {
    renderWorkspace();

    const instantRow = screen
      .getAllByText("Steakhouse USDC")
      .map((element) => element.closest("tr"))
      .find((row) => row?.textContent?.includes("6.2%"));
    if (!instantRow) throw new Error("Expected the instant strategy row");
    expect(within(instantRow).getByText("Kamino · Devnet")).toBeTruthy();
    expect(within(instantRow).queryByText("Instant")).toBeNull();
    expect(within(instantRow).getAllByRole("cell")).toHaveLength(5);

    const strategyTable = instantRow.closest("table");
    if (!strategyTable) throw new Error("Expected the available strategies table");
    expect(
      within(strategyTable)
        .getAllByRole("columnheader")
        .map((header) => header.textContent)
    ).toEqual(["Strategy", "APY", "TVL", "Your position", "Actions"]);
    expect(within(instantRow).getByText("$12.3M")).toBeTruthy();

    const delayedRow = screen.getByText("Veda Treasury Fund").closest("tr");
    if (!delayedRow) throw new Error("Expected the delayed strategy row");
    expect(within(delayedRow).getByText("Veda · Devnet")).toBeTruthy();
    expect(within(delayedRow).queryByText("Delayed · 7 days")).toBeNull();
    // No observed APY renders the placeholder, never a fabricated rate.
    expect(within(delayedRow).getAllByRole("cell")[1]?.textContent).toBe("\u2014");
    expect(delayedRow.textContent).not.toMatch(/\d%/);
  });

  it("discloses a Kamino vault's allocations in the Information column", async () => {
    const user = userEvent.setup();
    mocks.allocationsByVault.KvaultMainnet111111111111111111111111111111 = {
      asOf: "2026-09-14T17:53:52.895Z",
      allocations: [
        { reserve: "reserve-1", marketName: "SOL/BTC Market", actualPct: "23.94" },
        {
          reserve: "reserve-2",
          marketName: "A deliberately long lending market name that must truncate",
          actualPct: "76.00",
        },
        // A configured reserve holding nothing says nothing about where the
        // capital is; it never becomes a row.
        { reserve: "reserve-3", marketName: "Empty Market", actualPct: "0" },
      ],
      unallocated: { pct: "0.06" },
    };
    renderWorkspace();

    // Only mainnet Kamino vaults are readable (the allocations source is
    // mainnet-only): the devnet Kamino rows and the Veda fund never ask.
    expect(mocks.allocationsRequests).toContain("KvaultMainnet111111111111111111111111111111");
    expect(mocks.allocationsRequests).not.toContain("Kvault11111111111111111111111111111111111");
    expect(mocks.allocationsRequests).not.toContain("KvaultCatalogue1111111111111111111111111111");
    expect(mocks.allocationsRequests).not.toContain("VedaFund1111111111111111111111111111111111");

    const mainnetRow = screen
      .getAllByText("Kamino JLP Vault")
      .map((element) => element.closest("tr"))
      .find((row) => row?.textContent?.includes("8.1%"));
    if (!mainnetRow) throw new Error("Expected the mainnet mirror strategy row");
    // Deployed weight is the complement of the unallocated share.
    expect(within(mainnetRow).getByText("99.9% deployed")).toBeTruthy();

    const disclosure = within(mainnetRow).getByRole("button", { name: "99.9% deployed" });
    await user.hover(disclosure);
    // The table is named for assistive technology only; its column headings
    // are exposed as columnheaders, not hidden behind a decorative grid.
    expect(await screen.findByText("Vault allocations")).toBeTruthy();
    const disclosureTable = screen
      .getByRole("columnheader", { name: "Allocation" })
      .closest("table");
    if (!disclosureTable) throw new Error("Expected the allocations disclosure table");
    expect(within(disclosureTable).getByRole("columnheader", { name: "Market" })).toBeTruthy();
    // Two columns, heaviest market first, the idle share last: one weight per
    // row and nothing else (no token, supplied or APY figures).
    const bodyRows = within(disclosureTable)
      .getAllByRole("row")
      .slice(1)
      .map((row) =>
        within(row)
          .getAllByRole("cell")
          .map((cell) => cell.textContent)
      );
    expect(bodyRows).toEqual([
      ["A deliberately long lending market name that must truncate", "76.0%"],
      ["SOL/BTC Market", "23.9%"],
      ["Unallocated", "0.1%"],
    ]);
    expect(within(disclosureTable).queryByText("Empty Market")).toBeNull();
    // A long market name truncates inside its cell and keeps the full string
    // reachable, so nothing can run past the tooltip's edge.
    const longName = within(disclosureTable).getByText(
      "A deliberately long lending market name that must truncate"
    );
    expect(longName.className).toContain("truncate");
    expect(longName.getAttribute("title")).toBe(
      "A deliberately long lending market name that must truncate"
    );
    // The provider timestamp is a quiet footer, rendered in the viewer's
    // locale and zone (so the exact time is not pinned here).
    expect(screen.getByText(/^As of .+2026/)).toBeTruthy();
  });

  it("omits the idle row when nothing is unallocated", async () => {
    const user = userEvent.setup();
    mocks.allocationsByVault.KvaultMainnet111111111111111111111111111111 = {
      allocations: [
        { reserve: "reserve-1", marketName: "SOL/BTC Market", actualPct: "60" },
        // Kamino names an unnamed market by its address; the row shortens it
        // the way SDP shows any address and keeps the full string in `title`.
        {
          reserve: "reserve-2",
          marketName: "Dwg1aeZFYtsyMEkoyJn2ak8oPqaXMWd1uui6FBkM1872",
          actualPct: "40",
        },
      ],
      unallocated: { pct: "0" },
    };
    renderWorkspace();

    const mainnetRow = screen
      .getAllByText("Kamino JLP Vault")
      .map((element) => element.closest("tr"))
      .find((row) => row?.textContent?.includes("8.1%"));
    if (!mainnetRow) throw new Error("Expected the mainnet mirror strategy row");
    const disclosure = within(mainnetRow).getByRole("button", { name: "100.0% deployed" });
    await user.hover(disclosure);
    const disclosureTable = (
      await screen.findByRole("columnheader", { name: "Allocation" })
    ).closest("table");
    if (!disclosureTable) throw new Error("Expected the allocations disclosure table");
    const bodyRows = within(disclosureTable)
      .getAllByRole("row")
      .slice(1)
      .map((row) =>
        within(row)
          .getAllByRole("cell")
          .map((cell) => cell.textContent)
      );
    expect(bodyRows).toEqual([
      ["SOL/BTC Market", "60.0%"],
      ["Dwg1ae…1872", "40.0%"],
    ]);
    expect(within(disclosureTable).queryByText("Unallocated")).toBeNull();
    expect(within(disclosureTable).getByText("Dwg1ae…1872").getAttribute("title")).toBe(
      "Dwg1aeZFYtsyMEkoyJn2ak8oPqaXMWd1uui6FBkM1872"
    );
  });

  it("keeps the disclosure when the deployed weight cannot be certified", async () => {
    const user = userEvent.setup();
    mocks.allocationsByVault.KvaultMainnet111111111111111111111111111111 = {
      allocations: [{ reserve: "reserve-1", marketName: "SOL/BTC Market", actualPct: "23.94" }],
    };
    renderWorkspace();

    const mainnetRow = screen
      .getAllByText("Kamino JLP Vault")
      .map((element) => element.closest("tr"))
      .find((row) => row?.textContent?.includes("8.1%"));
    if (!mainnetRow) throw new Error("Expected the mainnet mirror strategy row");
    // No unallocated share means no certifiable summary weight, but the
    // per-reserve rows are still a real read: disclose them under a neutral
    // summary instead of hiding everything behind the placeholder.
    const disclosure = within(mainnetRow).getByRole("button", { name: "Allocation details" });
    await user.hover(disclosure);
    expect(await screen.findByText("SOL/BTC Market")).toBeTruthy();
    expect(within(mainnetRow).queryByText(/deployed/)).toBeNull();
  });

  it("adds no allocation detail when the allocations read fails", () => {
    mocks.allocationsByVault.KvaultMainnet111111111111111111111111111111 = "error";
    renderWorkspace();

    const mainnetRow = screen
      .getAllByText("Kamino JLP Vault")
      .map((element) => element.closest("tr"))
      .find((row) => row?.textContent?.includes("8.1%"));
    if (!mainnetRow) throw new Error("Expected the mainnet mirror strategy row");
    // The same detail line as a non-Kamino row: never a partial figure.
    expect(within(mainnetRow).getByText("Kamino")).toBeTruthy();
    expect(within(mainnetRow).queryByText(/deployed/)).toBeNull();
    expect(within(mainnetRow).queryByRole("button", { name: /Allocation details/ })).toBeNull();
  });

  it("keeps the last allocation disclosure when a later read fails", () => {
    mocks.allocationsByVault.KvaultMainnet111111111111111111111111111111 = {
      allocations: [{ reserve: "reserve-1", marketName: "SOL/BTC Market", actualPct: "99.94" }],
      unallocated: { pct: "0.06" },
    };
    mocks.allocationsFailAfterRead = true;
    renderWorkspace();

    const mainnetRow = screen
      .getAllByText("Kamino JLP Vault")
      .map((element) => element.closest("tr"))
      .find((row) => row?.textContent?.includes("8.1%"));
    if (!mainnetRow) throw new Error("Expected the mainnet mirror strategy row");
    // A refresh that failed says nothing new about the vault: the last read still stands.
    expect(within(mainnetRow).getByRole("button", { name: /99.9% deployed/ })).toBeTruthy();
  });

  it("adds no allocation detail to devnet Kamino rows and requests none", () => {
    renderWorkspace();

    // The devnet shelf's instant row shares the mainnet mirror's name: pick
    // the devnet row by its own observed APY.
    const instantRow = screen
      .getAllByText("Steakhouse USDC")
      .map((element) => element.closest("tr"))
      .find((row) => row?.textContent?.includes("6.2%"));
    if (!instantRow) throw new Error("Expected the instant strategy row");
    // Kamino's allocations source is mainnet-only: the devnet vault is an
    // unsupported read, so its detail line is the provider and network alone.
    const strategyCell = within(instantRow).getAllByRole("cell")[0];
    if (!strategyCell) throw new Error("Expected the strategy cell");
    expect(within(strategyCell).getByText("Kamino · Devnet")).toBeTruthy();
    expect(within(strategyCell).queryByRole("button")).toBeNull();
    expect(mocks.allocationsRequests).not.toContain("Kvault11111111111111111111111111111111111");
    // The devnet-only vault has no mainnet counterpart: the rough-name
    // intersection hides the whole row, so no cell of it can render at all.
    expect(screen.queryByText("Kamino Vault USDC")).toBeNull();
  });

  it("adds no allocation detail to a non-Kamino strategy", () => {
    renderWorkspace();

    const delayedRow = screen.getByText("Veda Treasury Fund").closest("tr");
    if (!delayedRow) throw new Error("Expected the delayed strategy row");
    expect(within(delayedRow).getByText("Veda · Devnet")).toBeTruthy();
    expect(within(delayedRow).queryByRole("button", { name: /deployed/ })).toBeNull();
  });

  it("keeps positions newest first until sorted, and sorts balances, APYs and TVLs with unavailable values last", async () => {
    const user = userEvent.setup();
    renderWorkspace();

    const activeSection = screen
      .getByRole("heading", { name: "Active positions" })
      .closest("section");
    const strategiesSection = screen
      .getByRole("heading", { name: "Available strategies" })
      .closest("section");
    const activeTable = activeSection?.querySelector("table");
    const strategiesTable = strategiesSection?.querySelector("table");
    if (!activeTable || !strategiesTable) throw new Error("Expected both Treasury tables");

    const firstColumn = (table: HTMLTableElement) =>
      within(table)
        .getAllByRole("row")
        .slice(1)
        .map((row) => within(row).getAllByRole("cell")[0]?.textContent);

    const balanceHeader = within(activeTable).getByRole("columnheader", { name: "Balance" });
    // The API's order, newest first: a balance that changes under an action never moves its row.
    expect(balanceHeader.getAttribute("aria-sort")).toBe("none");
    expect(firstColumn(activeTable)).toEqual([
      "Steakhouse USDCKamino · USDC",
      "Retired provider vaultKamino · USDC",
    ]);

    await user.click(within(activeTable).getByRole("button", { name: "Balance" }));
    expect(balanceHeader.getAttribute("aria-sort")).toBe("descending");
    expect(firstColumn(activeTable)).toEqual([
      "Steakhouse USDCKamino · USDC",
      "Retired provider vaultKamino · USDC",
    ]);

    await user.click(within(activeTable).getByRole("button", { name: "Balance" }));
    expect(balanceHeader.getAttribute("aria-sort")).toBe("ascending");
    expect(firstColumn(activeTable)).toEqual([
      "Retired provider vaultKamino · USDC",
      "Steakhouse USDCKamino · USDC",
    ]);

    const apyHeader = within(strategiesTable).getByRole("columnheader", { name: "APY" });
    const tvlHeader = within(strategiesTable).getByRole("columnheader", { name: "TVL" });
    expect(apyHeader.getAttribute("aria-sort")).toBe("descending");
    expect(tvlHeader.getAttribute("aria-sort")).toBe("none");
    expect(firstColumn(strategiesTable)).toEqual([
      "Kamino JLP VaultKamino",
      "Steakhouse USDCKamino",
      "Allez USDCKamino",
      "Steakhouse USDCKamino · Devnet",
      "Allez USDCKamino · Devnet",
      "Veda Treasury FundVeda · Devnet",
    ]);

    await user.click(within(strategiesTable).getByRole("button", { name: "APY" }));
    expect(apyHeader.getAttribute("aria-sort")).toBe("ascending");
    expect(firstColumn(strategiesTable)).toEqual([
      "Allez USDCKamino",
      "Steakhouse USDCKamino",
      "Kamino JLP VaultKamino",
      "Allez USDCKamino · Devnet",
      "Steakhouse USDCKamino · Devnet",
      "Veda Treasury FundVeda · Devnet",
    ]);

    await user.click(within(strategiesTable).getByRole("button", { name: "TVL" }));
    expect(apyHeader.getAttribute("aria-sort")).toBe("none");
    expect(tvlHeader.getAttribute("aria-sort")).toBe("descending");
    expect(firstColumn(strategiesTable)).toEqual([
      "Steakhouse USDCKamino",
      "Kamino JLP VaultKamino",
      "Allez USDCKamino",
      "Allez USDCKamino · Devnet",
      "Steakhouse USDCKamino · Devnet",
      "Veda Treasury FundVeda · Devnet",
    ]);

    await user.click(within(strategiesTable).getByRole("button", { name: "TVL" }));
    expect(tvlHeader.getAttribute("aria-sort")).toBe("ascending");
    expect(firstColumn(strategiesTable)).toEqual([
      "Allez USDCKamino",
      "Kamino JLP VaultKamino",
      "Steakhouse USDCKamino",
      "Steakhouse USDCKamino · Devnet",
      "Allez USDCKamino · Devnet",
      "Veda Treasury FundVeda · Devnet",
    ]);
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
    // "No positions yet" is a claim of absence like any other.
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
    expect(screen.queryByText("No positions yet")).toBeNull();
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
      .getAllByText("Steakhouse USDC")
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
    const walletsError = screen.getByText("Wallets could not be loaded. Refresh to try again.");
    // The failed read keeps the tile row's footprint, so the sections under it stay put.
    expect(walletsError.parentElement?.className).toContain(TREASURY_WALLETS_BODY);
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

  it("renders the summary hero and stat line without the legacy allocation bar", () => {
    renderWorkspace();

    expect(screen.queryByTestId("treasury-allocation-bar")).toBeNull();
    expect(screen.getByText("Deposited")).toBeTruthy();
    expect(screen.getAllByText("Available cash").length).toBeGreaterThan(0);
    expect(screen.getByText("available cash")).toBeTruthy();
    expect(screen.getByText("est. APY")).toBeTruthy();
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
    // be certified. The strategy card keeps its mainnet shelf and surfaces the
    // failed Devnet refresh without leaving stale Devnet deposit actions open.
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

    expect(within(livePositionRow()).getByText("$125.25")).toBeTruthy();
    expect(within(livePositionRow()).getByText("Last verified balance")).toBeTruthy();
    expect(livePositionRow().querySelector('[data-earn-vault-balance="stale"]')).toBeTruthy();

    // Summary side: deployed unavailable, never zero.
    expect(screen.getByLabelText("A position value could not be read")).toBeTruthy();
    // Wallet card: receipt tiles stay hidden (their mints are known from the
    // stale read), but the deployment must read unavailable, not idle.
    expect(screen.queryByText("kUSDC")).toBeNull();
    expect(screen.getByText("Deployed")).toBeTruthy();
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
    expect(screen.getByText("Deployed")).toBeTruthy();
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
    const catalogueOnlyRow = devnetStrategyRow("Allez USDC");
    if (!catalogueOnlyRow) throw new Error("Expected the catalogue-only strategy row");
    expect(catalogueOnlyRow.textContent).toContain("Live value unavailable");
    expect(catalogueOnlyRow.textContent).not.toContain("No active position");
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
    expect(screen.getByText("est. APY")).toBeTruthy();
  });

  it("reads an unhydratable position as unavailable in the summary, never zero", () => {
    mocks.livePositionTokenValue = undefined;
    renderWorkspace();

    expect(screen.getByLabelText("A position value could not be read")).toBeTruthy();
    expect(screen.getAllByText("$2,500.00").length).toBeGreaterThan(0);
    expect(screen.queryByText("0.0%")).toBeNull();
    expect(screen.queryByText("100.0%")).toBeNull();
    // The wallet's deployed line refuses a partial total for the same reason:
    // the one readable value appears only as that position's own balance,
    // never as a wallet or summary total.
    expect(screen.getAllByText("Live value unavailable").length).toBeGreaterThan(0);
    const readableValues = screen.getAllByText("$5.25");
    expect(readableValues.length).toBeGreaterThan(0);
    expect(readableValues.every((el) => el.closest("[data-earn-vault-balance]") !== null)).toBe(
      true
    );
  });

  it("opens the vault exit modal from a position row", async () => {
    const user = userEvent.setup();
    renderWorkspace();

    const vaultPositionRow = screen
      .getAllByText("Steakhouse USDC")
      .map((element) => element.closest("tr"))
      .find((row) => row && within(row).queryByRole("button", { name: "Withdraw" }));
    if (!vaultPositionRow) throw new Error("Expected vault position row");

    await user.click(within(vaultPositionRow).getByRole("button", { name: "Withdraw" }));
    expect(screen.getByRole("dialog").textContent).toBe("Withdraw from Steakhouse USDC");
  });

  it("reopens an escrowed exit from its activity once the holdings table drops the position", async () => {
    renderWorkspace();
    // The exited fixture holds no shares, so its row and exit are gone from the table.
    expect(screen.queryByText("Exited provider vault")).toBeNull();
    const recovery = mocks.coreFeed?.withdrawalRecovery;
    const escrowed = recovery?.positions[0];
    if (!recovery || !escrowed) throw new Error("Expected a recoverable position");
    expect(recovery.positions.map(({ id }) => id)).toEqual(["earn_vault_position_exited"]);

    await act(async () => recovery.onOpen(escrowed));
    // The dialog module loads on demand, behind its loading frame.
    await waitFor(() =>
      expect(screen.getByRole("dialog").textContent).toBe("Withdraw from Exited provider vault")
    );
    expect(mocks.coreAction?.defaultWithdrawAll).toBe(true);
    expect(mocks.coreAction?.intermediate).toBe(false);

    // Closing the dialog leaves the activity entry in place.
    act(() => mocks.coreAction?.onClose());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.coreFeed?.withdrawalRecovery?.positions).toEqual([escrowed]);

    // A holding row's exit afterwards starts from an amount, not the recovery's All.
    await userEvent
      .setup()
      .click(within(livePositionRow()).getByRole("button", { name: "Withdraw" }));
    expect(screen.getByRole("dialog").textContent).toBe("Withdraw from Steakhouse USDC");
    expect(mocks.coreAction?.defaultWithdrawAll).toBe(false);
  });

  it("keeps the vault exit verb live in production, where deposits are closed", () => {
    // ADR 0002: the environment fail-close guards the way IN only. A position
    // that exists in production must keep its way out.
    mocks.environment = "production";
    renderWorkspace();

    const vaultPositionRow = screen
      .getAllByText("Steakhouse USDC")
      .map((element) => element.closest("tr"))
      .find((row) => row && within(row).queryByRole("button", { name: "Withdraw" }));
    if (!vaultPositionRow) throw new Error("Expected vault position row");
    expect(
      (within(vaultPositionRow).getByRole("button", { name: "Withdraw" }) as HTMLButtonElement)
        .disabled
    ).toBe(false);
  });

  it("opens Veda vault deposits in production once its mainnet vault is live", () => {
    // Kamino opened in PRO-1986; PRO-1777 filled Veda's mainnet deployment, so
    // the deposit-environment map opens its rows to Production projects too —
    // each provider's own deployment table decides, never a global switch.
    mocks.environment = "production";
    render(
      <EnglishTestI18n>
        <TreasurySolutionsWorkspace
          providerAccess={{
            kamino: { entitled: true, configured: true, enabled: true },
            veda: { entitled: true, configured: true, enabled: true },
          }}
        />
      </EnglishTestI18n>
    );

    const row = screen.getByText("Veda Treasury Fund").closest("tr");
    if (!row) throw new Error("Expected vault strategy row");
    expect(within(row).queryByText("Sandbox only")).toBeNull();
    expect(
      (within(row).getByRole("button", { name: "Deposit" }) as HTMLButtonElement).disabled
    ).toBe(false);
    expect(screen.getByLabelText(/Rates are provider-reported and can change/)).toBeTruthy();
  });
});

describe("TreasurySolutionsWorkspace — combined strategy catalogue (PRO-1742)", () => {
  it("shows both networks in sandbox while keeping mainnet deposits disabled", async () => {
    const user = userEvent.setup();
    renderWorkspace();

    const section = screen
      .getByRole("heading", { name: "Available strategies" })
      .closest("section");
    expect(section).not.toBeNull();
    const catalogue = within(section as HTMLElement);
    expect(mocks.strategiesClusterRequests).toContain("mainnet-beta");
    expect(catalogue.queryByRole("switch")).toBeNull();

    const mainnetRow = catalogue.getByText("Kamino JLP Vault").closest("tr");
    const devnetRow = devnetStrategyRow("Steakhouse USDC");
    expect(mainnetRow).not.toBeNull();
    expect(devnetRow).toBeDefined();
    const mainnetCells = within(mainnetRow as HTMLTableRowElement);
    expect(mainnetCells.getByText("$32M")).toBeTruthy();
    expect(mainnetCells.queryByText(/Devnet/)).toBeNull();
    expect(within(devnetRow as HTMLTableRowElement).getByText("Kamino · Devnet")).toBeTruthy();
    expect(mainnetCells.queryByRole("button", { name: "Deposit" })).toBeNull();
    expect(mainnetCells.getByText("Mainnet only")).toBeTruthy();
    expect(
      within(devnetRow as HTMLTableRowElement)
        .getByRole("button", { name: "Deposit" })
        .hasAttribute("disabled")
    ).toBe(false);

    const reason = "Mainnet vaults are view-only in Sandbox.";
    const reasonHint = mainnetCells.getByRole("button", { name: reason });
    await user.hover(reasonHint);
    expect(await screen.findByText(reason)).toBeTruthy();
  });

  it("keeps production on its environment shelf with no network toggle", () => {
    mocks.environment = "production";
    renderWorkspace();

    expect(screen.queryByRole("switch")).toBeNull();
    // Production's default shelf is already mainnet, so no explicit cluster is needed.
    expect(mocks.strategiesClusterRequests).not.toContain("mainnet-beta");
  });

  it("shows the Sandbox devnet shelf as the rough-name intersection with mainnet, Veda excepted", () => {
    renderWorkspace();

    const section = screen
      .getByRole("heading", { name: "Available strategies" })
      .closest("section");
    if (!section) throw new Error("Expected the strategy catalogue");
    const catalogue = within(section);
    // Matched to a mainnet counterpart the loaded mainnet shelf actually
    // offers, from the same provider.
    expect(devnetStrategyRow("Steakhouse USDC")).toBeDefined();
    expect(devnetStrategyRow("Allez USDC")).toBeDefined();
    // Veda is exempt by provider, so its strategies skip the intersection.
    expect(catalogue.getByText("Veda Treasury Fund")).toBeTruthy();
    // A devnet vault with no mainnet counterpart stays off the shelf.
    expect(catalogue.queryByText("Kamino Vault USDC")).toBeNull();
    // And so does a mapped name the mainnet shelf never lists: the recorded
    // RockawayX pair is vetoed by the catalogue check, so the Sandbox shelf
    // cannot advertise what Production does not offer.
    expect(devnetStrategyRow("RockawayX RWA USDC")).toBeUndefined();
  });

  it("keeps mainnet strategies visible while the Devnet catalogue loads", () => {
    mocks.strategiesLoading = true;
    renderWorkspace();

    const section = screen
      .getByRole("heading", { name: "Available strategies" })
      .closest("section");
    if (!section) throw new Error("Expected the strategy catalogue");
    const catalogue = within(section);
    expect(catalogue.getByText("Kamino JLP Vault")).toBeTruthy();
    expect(devnetStrategyRow("Steakhouse USDC")).toBeUndefined();
    expect(catalogue.getByText("Loading Devnet strategies.")).toBeTruthy();
  });

  it("keeps mainnet strategies visible when the Devnet catalogue fails", () => {
    mocks.strategiesUnavailable = true;
    renderWorkspace();

    const section = screen
      .getByRole("heading", { name: "Available strategies" })
      .closest("section");
    if (!section) throw new Error("Expected the strategy catalogue");
    const catalogue = within(section);
    expect(catalogue.getByText("Kamino JLP Vault")).toBeTruthy();
    expect(devnetStrategyRow("Steakhouse USDC")).toBeUndefined();
    expect(catalogue.getByText("Devnet strategies could not be loaded.")).toBeTruthy();
    expect(catalogue.queryByText("Strategies could not be loaded")).toBeNull();
  });

  it("keeps devnet strategies depositable when the mainnet catalogue fails (PRO-1961)", () => {
    mocks.mainnetStrategiesUnavailable = true;
    renderWorkspace();

    const section = screen
      .getByRole("heading", { name: "Available strategies" })
      .closest("section");
    if (!section) throw new Error("Expected the strategy catalogue");
    const catalogue = within(section);
    const devnetRow = catalogue.getByText("Steakhouse USDC").closest("tr");
    if (!devnetRow) throw new Error("Expected the devnet strategy row");
    expect(
      within(devnetRow).getByRole("button", { name: "Deposit" }).hasAttribute("disabled")
    ).toBe(false);
    expect(catalogue.queryByText("Kamino JLP Vault")).toBeNull();
    expect(catalogue.getByText("Mainnet strategies could not be loaded.")).toBeTruthy();
    expect(catalogue.queryByText("Strategies could not be loaded")).toBeNull();
  });

  it("keeps devnet strategies visible while the mainnet catalogue loads (PRO-1961)", () => {
    mocks.mainnetStrategiesLoading = true;
    renderWorkspace();

    const section = screen
      .getByRole("heading", { name: "Available strategies" })
      .closest("section");
    if (!section) throw new Error("Expected the strategy catalogue");
    const catalogue = within(section);
    expect(catalogue.getByText("Steakhouse USDC")).toBeTruthy();
    expect(catalogue.queryByText("Kamino JLP Vault")).toBeNull();
    expect(catalogue.getByText("Loading Mainnet strategies.")).toBeTruthy();
  });

  it("reserves the full catalogue error for both shelves failing (PRO-1961)", () => {
    mocks.mainnetStrategiesUnavailable = true;
    mocks.strategiesUnavailable = true;
    renderWorkspace();

    const section = screen
      .getByRole("heading", { name: "Available strategies" })
      .closest("section");
    if (!section) throw new Error("Expected the strategy catalogue");
    const catalogue = within(section);
    expect(catalogue.getByText("Strategies could not be loaded")).toBeTruthy();
    expect(catalogue.queryByText("Steakhouse USDC")).toBeNull();
    expect(catalogue.queryByText("Kamino JLP Vault")).toBeNull();
    expect(
      catalogue.queryByText(
        /strategies could not be loaded\.|Loading (Devnet|Mainnet) strategies\./
      )
    ).toBeNull();
  });

  it("refreshes the environment and mainnet shelves once each", async () => {
    const user = userEvent.setup();
    renderWorkspace();

    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(mocks.refreshStrategies).toHaveBeenCalledTimes(2);
  });
});

describe("TreasurySolutionsWorkspace — provider plan", () => {
  const notEntitled = { entitled: false, configured: true, enabled: false };
  const entitled = { entitled: true, configured: true, enabled: true };
  const noneEntitled: EarnProviderAccess = Object.fromEntries(
    SURFACED_VAULT_DIRECT_EARN_PROVIDERS.map((provider) => [provider, notEntitled])
  );
  const planNotice = "New deposits aren't on your plan. Contact us to enable them.";

  function renderWithAccess(providerAccess: EarnProviderAccess | null) {
    return render(
      <EnglishTestI18n>
        <TreasurySolutionsWorkspace providerAccess={providerAccess} />
      </EnglishTestI18n>
    );
  }

  function strategyRow(name: string): HTMLTableRowElement {
    const row = screen.getByText(name).closest("tr");
    if (!row) throw new Error(`Expected a strategy row for ${name}`);
    return row;
  }

  it("says once that new deposits are off the plan and names it on each affected row", () => {
    renderWithAccess(noneEntitled);

    const section = screen
      .getByRole("heading", { name: "Available strategies" })
      .closest("section");
    expect(within(section as HTMLElement).getByText(planNotice)).toBeTruthy();
    const row = devnetStrategyRow("Steakhouse USDC");
    if (!row) throw new Error("Expected the devnet Steakhouse row");
    expect(within(row).getByText("Not on your plan")).toBeTruthy();
    expect(within(row).queryByRole("button", { name: "Deposit" })).toBeNull();
    expect(screen.queryByText("Setup required")).toBeNull();
  });

  it("keeps the notice off while any offered provider is on the plan", () => {
    renderWithAccess({ ...noneEntitled, kamino: entitled });

    expect(screen.queryByText(planNotice)).toBeNull();
    expect(within(strategyRow("Veda Treasury Fund")).getByText("Not on your plan")).toBeTruthy();
  });

  it("says access could not be checked, never that it is off the plan, when the read failed", () => {
    renderWithAccess(null);

    expect(screen.queryByText(planNotice)).toBeNull();
    const row = devnetStrategyRow("Steakhouse USDC");
    if (!row) throw new Error("Expected the devnet Steakhouse row");
    expect(within(row).getByText("Couldn't check access")).toBeTruthy();
    expect(screen.queryByText("Not on your plan")).toBeNull();
  });
});
