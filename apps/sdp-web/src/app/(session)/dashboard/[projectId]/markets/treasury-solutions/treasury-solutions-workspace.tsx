"use client";

import type { SdpEnvironment } from "@sdp/types/api-keys";
import type {
  EarnStrategy,
  EarnVaultDepositRecord,
  EarnVaultPosition,
  EarnVaultWithdrawal,
} from "@sdp/types/earn";
import type { Operation } from "@sdp/types/operations";
import { WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types/well-known-tokens";
import { Modal } from "@sdp/ui/modal";
import { Loader2Icon } from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useMemo, useRef, useState } from "react";
import { useSWRConfig } from "swr";
import { EarnCoreOperations } from "@/app/(session)/dashboard/[projectId]/markets/earn/earn-core-operations";
import { useEarnStrategies } from "@/app/(session)/dashboard/[projectId]/markets/earn/earn-data";
import { EARN_TRANSACTION_MODAL_FRAME } from "@/app/(session)/dashboard/[projectId]/markets/earn/earn-modal";
import { earnQueryKeys } from "@/app/(session)/dashboard/[projectId]/markets/earn/earn-query-key";
import type { EarnProviderAccess } from "@/app/(session)/dashboard/[projectId]/markets/earn/earn-surfacing";
import type { EarnVaultParRedemptionSource } from "@/app/(session)/dashboard/[projectId]/markets/earn/earn-vault-holding";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import { type EarnOperationsFeed, isEarnOperationTerminal } from "@/lib/earn-core-data";
import { filterSandboxDevnetStrategies } from "./devnet-mainnet-intersection";
import { kaminoAllocationsVaults, useKaminoVaultAllocations } from "./kamino-allocations";
import {
  estimatedTreasuryApy,
  summarizeTreasuryAllocation,
  type TreasuryAllocation,
  type VaultShareMintVocabulary,
} from "./treasury-allocation";
import type { VaultMovementBalanceState } from "./treasury-vault-balance";
import { TreasuryWorkspaceContent } from "./treasury-workspace-content";
import { useTreasuryBalances } from "./use-treasury-balances";

const EMPTY_TREASURY_ACTIVITIES = [] as const;

export function EarnTransactionModalLoading() {
  const t = useTranslations();
  const label = t("Shared.SharedComponents.loading");
  return (
    <Modal isOpen ariaLabel={label} showCloseButton={false} {...EARN_TRANSACTION_MODAL_FRAME}>
      <div
        aria-live="polite"
        className="flex min-h-28 items-center justify-center gap-2 p-6 text-body text-secondary"
        role="status"
      >
        <Loader2Icon aria-hidden="true" className="size-4 motion-safe:animate-spin" />
        {label}
      </div>
    </Modal>
  );
}

const EarnCoreActionModal = dynamic(
  () =>
    import("@/app/(session)/dashboard/[projectId]/markets/earn/earn-core-action-modal").then(
      (module) => module.EarnCoreActionModal
    ),
  { loading: EarnTransactionModalLoading, ssr: false }
);
export type TrackedVaultDeposit = Pick<
  EarnVaultDepositRecord,
  "failureReason" | "movementId" | "positionId" | "status"
> &
  VaultMovementBalanceState & {
    createdAt?: string;
    provisionalPosition?: EarnVaultPosition;
  };

export type TrackedVaultWithdrawal = Pick<
  EarnVaultWithdrawal,
  "createdAt" | "failureReason" | "movementId" | "positionId" | "status"
> &
  VaultMovementBalanceState;

function treasuryShareMints(
  positions: readonly EarnVaultPosition[] | undefined,
  strategies: readonly EarnStrategy[] | undefined,
  strategiesError: unknown
): VaultShareMintVocabulary {
  const known = new Set<string>();
  for (const position of positions ?? []) {
    if (!WELL_KNOWN_TOKEN_BY_MINT.get(position.shareMint)?.isUsdStable) {
      known.add(position.shareMint);
    }
  }
  for (const strategy of strategies ?? []) {
    const shareMint = strategy.shareMint;
    if (shareMint && !WELL_KNOWN_TOKEN_BY_MINT.get(shareMint)?.isUsdStable) {
      known.add(shareMint);
    }
  }
  return {
    known,
    complete:
      strategies !== undefined &&
      !strategiesError &&
      strategies.every((strategy) => strategy.shareMint !== undefined),
  };
}

function availableValue<Value>(error: unknown, value: Value | undefined): Value | undefined {
  return error ? undefined : value;
}

function treasuryPortfolioApy(
  allocation: TreasuryAllocation,
  positions: readonly EarnVaultPosition[] | undefined,
  positionsError: unknown,
  strategies: readonly EarnStrategy[] | undefined,
  strategiesError: unknown
): string | undefined {
  if (allocation.deployedValue === undefined || positionsError || strategiesError) return undefined;
  return estimatedTreasuryApy({ positions, strategies });
}

function treasurySummaryLoading(input: {
  positionsError: unknown;
  positionsLoading: boolean;
  strategiesError: unknown;
  strategiesLoading: boolean;
  walletsError: unknown;
  walletsLoading: boolean;
}): boolean {
  const {
    positionsError,
    positionsLoading,
    strategiesError,
    strategiesLoading,
    walletsError,
    walletsLoading,
  } = input;
  if (walletsError || positionsError || strategiesError) return false;
  return walletsLoading || positionsLoading || strategiesLoading;
}

/**
 * Sandbox lists the mirrored mainnet shelf above the depositable devnet shelf.
 * Neither shelf gates the other: whichever has loaded renders, and only when
 * both are missing is the catalogue itself unavailable.
 */
function mergeStrategyCatalogues(
  mainnet: readonly EarnStrategy[] | undefined,
  devnet: readonly EarnStrategy[] | undefined
): EarnStrategy[] | undefined {
  if (!mainnet) return devnet ? [...devnet] : undefined;
  if (!devnet) return [...mainnet];

  const combined = [...mainnet];
  const seen = new Set(mainnet.map((strategy) => strategy.id));
  for (const strategy of devnet) {
    if (seen.has(strategy.id)) continue;
    seen.add(strategy.id);
    combined.push(strategy);
  }
  return combined;
}

/**
 * The strategy list the treasury page renders. Production shows its own
 * shelf; Sandbox shows the mirrored mainnet shelf above the depositable
 * devnet shelf. Each Sandbox shelf drops its rows behind its own failed read,
 * so a stale list never outlives the error that should have replaced it, and
 * neither shelf's failure or slow load takes the other's rows off the screen.
 */
function combinedCatalogueStrategies({
  sandboxCatalogue,
  baseCatalogueStrategies,
  baseCatalogueError,
  strategies,
  strategiesError,
}: {
  sandboxCatalogue: boolean;
  baseCatalogueStrategies: readonly EarnStrategy[] | undefined;
  baseCatalogueError: unknown;
  strategies: readonly EarnStrategy[] | undefined;
  strategiesError: unknown;
}): readonly EarnStrategy[] | undefined {
  if (!sandboxCatalogue) return baseCatalogueStrategies;
  const mainnetShelf = baseCatalogueError ? undefined : baseCatalogueStrategies;
  return mergeStrategyCatalogues(
    mainnetShelf,
    // The devnet rows show only where the mainnet shelf actually offers the
    // recorded counterpart (see `devnet-mainnet-intersection.ts`); the
    // allocation summary and the share-mint vocabulary keep the unfiltered
    // shelf, because this is a browse decision and never a money gate.
    strategiesError ? undefined : filterSandboxDevnetStrategies(strategies, mainnetShelf)
  );
}

// The allocation summary reads the environment's actionable shelf, so the
// shelves a workspace needs depend on the environment. Sandbox automatically
// combines the devnet shelf with the mirrored mainnet catalogue, preserving
// the API's `fundable: false` response on mainnet rows. Production's default
// shelf is already mainnet.
function useTreasuryCatalogueShelves(sdpEnvironment: SdpEnvironment) {
  const sandboxCatalogue = sdpEnvironment === "sandbox";
  const catalogueCluster = sandboxCatalogue ? "mainnet-beta" : undefined;
  const {
    strategies,
    error: strategiesError,
    isLoading: strategiesLoading,
    refresh: refreshStrategies,
  } = useEarnStrategies();
  const {
    strategies: baseCatalogueStrategies,
    error: baseCatalogueError,
    isLoading: baseCatalogueLoading,
    refresh: refreshCatalogue,
  } = useEarnStrategies({ cluster: catalogueCluster });
  const catalogueStrategies = useMemo(
    () =>
      combinedCatalogueStrategies({
        sandboxCatalogue,
        baseCatalogueStrategies,
        baseCatalogueError,
        strategies,
        strategiesError,
      }),
    [baseCatalogueError, baseCatalogueStrategies, sandboxCatalogue, strategies, strategiesError]
  );
  // Sandbox reserves the full-card error for both shelves failing; a single
  // failed shelf is reported inline above the rows the other shelf still has.
  const bothShelvesFailed = Boolean(baseCatalogueError && strategiesError);
  const catalogueError = !sandboxCatalogue || bothShelvesFailed ? baseCatalogueError : undefined;
  const mainnetCatalogueError = sandboxCatalogue ? baseCatalogueError : undefined;
  const mainnetCatalogueLoading = sandboxCatalogue && baseCatalogueLoading;
  const devnetCatalogueError = sandboxCatalogue ? strategiesError : undefined;
  const devnetCatalogueLoading = sandboxCatalogue && strategiesLoading;
  const catalogueLoading = baseCatalogueLoading || (sandboxCatalogue && strategiesLoading);
  return {
    catalogueCluster,
    catalogueStrategies,
    catalogueError,
    catalogueLoading,
    mainnetCatalogueError,
    mainnetCatalogueLoading,
    devnetCatalogueError,
    devnetCatalogueLoading,
    refreshCatalogue,
    refreshStrategies,
    strategies,
    strategiesError,
    strategiesLoading,
  };
}

export function TreasurySolutionsWorkspace({
  providerAccess,
}: {
  providerAccess: EarnProviderAccess | null;
}) {
  const { sdpEnvironment } = useDashboardWorkspace();
  const {
    catalogueCluster,
    catalogueStrategies,
    catalogueError,
    catalogueLoading,
    mainnetCatalogueError,
    mainnetCatalogueLoading,
    devnetCatalogueError,
    devnetCatalogueLoading,
    refreshCatalogue,
    refreshStrategies,
    strategies,
    strategiesError,
    strategiesLoading,
  } = useTreasuryCatalogueShelves(sdpEnvironment);
  // The Information column's one read for every Kamino row the table shows.
  const kaminoAllocationVaults = useMemo(
    () => kaminoAllocationsVaults(catalogueStrategies ?? []),
    [catalogueStrategies]
  );
  const kaminoAllocations = useKaminoVaultAllocations(kaminoAllocationVaults);
  const [depositStrategy, setDepositStrategy] = useState<EarnStrategy | null>(null);
  const [withdrawPosition, setWithdrawPosition] = useState<EarnVaultPosition | null>(null);
  const [withdrawParSource, setWithdrawParSource] =
    useState<EarnVaultParRedemptionSource>("shares");
  const openVaultExit = useCallback(
    (position: EarnVaultPosition, parSource: EarnVaultParRedemptionSource = "shares") => {
      setWithdrawParSource(parSource);
      setWithdrawPosition(position);
    },
    []
  );
  const {
    positions,
    positionsError,
    positionsLoading,
    wallets,
    walletsError,
    walletsLoading,
    balancesRefreshing,
    balanceOf,
    refresh: refreshTreasuryBalances,
    refreshOperation,
  } = useTreasuryBalances(EMPTY_TREASURY_ACTIVITIES);

  const { mutate: mutateCore } = useSWRConfig();
  const observedCoreResults = useRef(new Map<string, { observation: string; balance: string }>());
  const onCoreUpdated = useCallback(
    (operation: Operation) => {
      const observation = JSON.stringify(operation);
      const balance = JSON.stringify([operation.status, operation.resourceRef, operation.result]);
      const previous = observedCoreResults.current.get(operation.id);
      if (previous?.observation === observation) return;
      observedCoreResults.current.set(operation.id, { observation, balance });
      void mutateCore<EarnOperationsFeed>(
        earnQueryKeys.operations(),
        (current) => ({
          activeIds: current?.activeIds ?? [],
          nextCursor: current?.nextCursor ?? null,
          expanded: current?.expanded ?? false,
          operations: current?.operations.some((candidate) => candidate.id === operation.id)
            ? current.operations.map((candidate) =>
                candidate.id === operation.id ? operation : candidate
              )
            : [operation, ...(current?.operations ?? [])],
        }),
        { revalidate: false }
      );
      // Provider heartbeats can change updatedAt without changing any holdings.
      if (previous?.balance === balance) return;
      const result = operation.result;
      if (!result || !("walletId" in result.source)) return;
      if (operation.status === "completed" && operation.resourceRef?.kind === "earn.movement") {
        void refreshOperation(operation.resourceRef.id, result.positionId, result.source.walletId);
      } else if (
        (operation.resourceRef?.kind === "earn.withdrawal_request" &&
          (operation.status === "settling" || isEarnOperationTerminal(operation))) ||
        (operation.resourceRef?.kind === "earn.withdrawal_recovery" &&
          operation.status === "completed")
      ) {
        void refreshTreasuryBalances();
      }
    },
    [mutateCore, refreshOperation, refreshTreasuryBalances]
  );

  const activeWallets = useMemo(() => wallets ?? [], [wallets]);
  // Every share mint the page knows about, from positions AND the catalogue:
  // a wallet can hold receipt tokens for a strategy it has no recorded
  // position in (deposited outside SDP), and those tiles are still not cash.
  // A USD-stable mint can never be a share mint; a corrupt catalogue row
  // claiming one must not hide real cash tiles the summary still counts.
  //
  // The known set stays best-effort in every state, because hiding a receipt
  // tile only needs the mint to be known. `complete` is the stricter claim,
  // and it needs three things:
  //   - the catalogue landed at all (it is the only witness for a holding with
  //     no position row),
  //   - the read is not stale behind a failed revalidation, which would be
  //     missing any strategy added since (the strategy table already renders
  //     its error state over stale rows, so this matches that posture), and
  //   - every row actually NAMED its share mint, since a row without one
  //     contributes nothing and leaves a real vault unnameable.
  const shareMints = useMemo(
    () => treasuryShareMints(positions, strategies, strategiesError),
    [positions, strategies, strategiesError]
  );
  // Every figure on this page comes from here, so no two surfaces can compute
  // the same thing differently.
  const allocation = useMemo(
    () =>
      summarizeTreasuryAllocation({
        positions: availableValue(positionsError, positions),
        shareMints,
        wallets: availableValue(walletsError, wallets),
      }),
    [positions, positionsError, shareMints, wallets, walletsError]
  );
  const portfolioApy = useMemo(
    () => treasuryPortfolioApy(allocation, positions, positionsError, strategies, strategiesError),
    [allocation, positions, positionsError, strategies, strategiesError]
  );
  const summaryLoading = treasurySummaryLoading({
    positionsError,
    positionsLoading,
    strategiesError,
    strategiesLoading,
    walletsError,
    walletsLoading,
  });
  const refreshTreasury = () => {
    void refreshTreasuryBalances();
    refreshStrategies();
    if (catalogueCluster !== undefined) refreshCatalogue();
  };
  return (
    <DashboardWorkspaceOverviewPanel>
      <TreasuryWorkspaceContent
        activeWallets={activeWallets}
        allocation={allocation}
        catalogueFailed={Boolean(catalogueError)}
        catalogueLoading={catalogueLoading && catalogueStrategies === undefined}
        catalogueStrategies={catalogueStrategies}
        devnetCatalogueFailed={Boolean(devnetCatalogueError)}
        devnetCatalogueLoading={devnetCatalogueLoading}
        environment={sdpEnvironment}
        kaminoAllocations={kaminoAllocations}
        mainnetCatalogueFailed={Boolean(mainnetCatalogueError)}
        mainnetCatalogueLoading={mainnetCatalogueLoading}
        onDeposit={setDepositStrategy}
        onRefresh={refreshTreasury}
        onWithdrawPosition={openVaultExit}
        portfolioApy={portfolioApy}
        positions={positions}
        positionsFailed={Boolean(positionsError)}
        positionsLoading={positionsLoading}
        balanceOf={balanceOf}
        providerAccess={providerAccess}
        summaryLoading={summaryLoading}
        balancesRefreshing={balancesRefreshing}
        vaultDeposits={[]}
        vaultWithdrawals={[]}
        walletsFailed={Boolean(walletsError)}
        walletsLoading={walletsLoading}
      />

      <EarnCoreOperations
        onUpdated={onCoreUpdated}
        strategies={catalogueStrategies}
        positions={positions}
      />

      {depositStrategy ? (
        <EarnCoreActionModal
          kind="deposit"
          strategy={depositStrategy}
          onClose={() => setDepositStrategy(null)}
          onUpdated={onCoreUpdated}
        />
      ) : null}

      {withdrawPosition ? (
        <EarnCoreActionModal
          kind="withdraw"
          position={withdrawPosition}
          intermediate={withdrawParSource === "intermediate"}
          onClose={() => setWithdrawPosition(null)}
          onUpdated={onCoreUpdated}
        />
      ) : null}
    </DashboardWorkspaceOverviewPanel>
  );
}
