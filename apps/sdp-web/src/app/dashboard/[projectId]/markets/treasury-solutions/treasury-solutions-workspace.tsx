"use client";

import type { SdpEnvironment } from "@sdp/types/api-keys";
import type {
  EarnProgram,
  EarnProgramWithdrawalRecord,
  EarnStrategy,
  EarnVaultDepositRecord,
  EarnVaultPosition,
  EarnVaultWithdrawal,
} from "@sdp/types/earn";
import { WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types/well-known-tokens";
import { Modal } from "@sdp/ui/modal";
import { Loader2Icon } from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EARN_TRANSACTION_MODAL_FRAME } from "@/app/dashboard/[projectId]/markets/earn/earn-modal";
import {
  EarnVaultDepositOutcomeTracker,
  EarnVaultWithdrawalOutcomeTracker,
  EarnWithdrawalOutcomeTracker,
} from "@/app/dashboard/[projectId]/markets/earn/earn-outcome-trackers";
import {
  isEarnVaultDepositInFlight,
  isEarnVaultWithdrawalInFlight,
  useEarnPrograms,
  useEarnProgramWithdrawals,
  useEarnStrategies,
  useEarnVaultDeposits,
  useEarnVaultWithdrawals,
} from "@/app/dashboard/[projectId]/markets/earn/earn-program-data";
import type { EarnProviderAccess } from "@/app/dashboard/[projectId]/markets/earn/earn-surfacing";
import type { EarnVaultParRedemptionSource } from "@/app/dashboard/[projectId]/markets/earn/earn-vault-par-redemption-modal";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import { filterSandboxDevnetStrategies } from "./devnet-mainnet-intersection";
import { kaminoAllocationsVaults, useKaminoVaultAllocations } from "./kamino-allocations";
import {
  estimatedTreasuryApy,
  summarizeTreasuryAllocation,
  type TreasuryAllocation,
  type VaultShareMintVocabulary,
} from "./treasury-allocation";
import {
  observeVaultMovementCommit,
  type TrackedVaultMovement,
  type VaultMovementBalanceState,
  vaultActivities,
} from "./treasury-vault-balance";
import { TreasuryWorkspaceContent } from "./treasury-workspace-content";
import { useTreasuryBalances } from "./use-treasury-balances";

// The three transaction surfaces account for most of this route's client
// module graph. They are not needed to inspect a portfolio, so load each only
// after the corresponding action opens it. Outcome polling stays in the small
// tracker module above and remains immediate after a reload.
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

const EarnVaultDepositModal = dynamic(
  () =>
    import("@/app/dashboard/[projectId]/markets/earn/earn-vault-deposit-modal").then(
      (module) => module.EarnVaultDepositModal
    ),
  { loading: EarnTransactionModalLoading, ssr: false }
);
const EarnVaultExitModal = dynamic(
  () =>
    import("@/app/dashboard/[projectId]/markets/earn/earn-vault-exit-modal").then(
      (module) => module.EarnVaultExitModal
    ),
  { loading: EarnTransactionModalLoading, ssr: false }
);
const EarnWithdrawModal = dynamic(
  () =>
    import("@/app/dashboard/[projectId]/markets/earn/earn-withdraw-modal").then(
      (module) => module.EarnWithdrawModal
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

/** What a caller hands the watch lists; order and commit stamps are this file's to assign. */
type VaultMovementWatchInput<Movement extends VaultMovementBalanceState> = Omit<
  Movement,
  "committedObservedAt" | "observedOrder"
>;

type VaultDepositWatchInput = VaultMovementWatchInput<TrackedVaultDeposit>;

type VaultWithdrawalWatchInput = VaultMovementWatchInput<TrackedVaultWithdrawal>;

const MAX_VISIBLE_VAULT_ACTIVITY = 50;

function replaceTrackedVaultMovement<
  Movement extends TrackedVaultMovement,
  Update extends { movementId: string; status: string },
>(current: readonly Movement[], updated: Update): readonly Movement[] {
  return current.map((candidate) =>
    candidate.movementId === updated.movementId
      ? observeVaultMovementCommit({ ...candidate, ...updated })
      : candidate
  );
}

/**
 * Pure merge for the vault deposit/withdrawal watch lists: append the incoming
 * movements newest-first — callers reverse before passing so the latest
 * observed movement for a position stays last and wins the status column's map
 * reduction — refresh rows already present, and keep the list bounded.
 * `settledIds` is load-bearing, not defensive: the ledger list keeps
 * re-asserting a row until the server marks it terminal, so without a
 * tombstone a settled movement would resume polling. Shared by the deposit and
 * withdrawal watchers, whose updaters are otherwise line-for-line identical.
 */
function mergeTrackedVaultMovements<Movement extends TrackedVaultMovement>(
  current: readonly Movement[],
  incoming: readonly Movement[],
  settledIds: ReadonlySet<string>
): readonly Movement[] {
  const next = [...current];
  for (const movement of incoming) {
    const existingIndex = next.findIndex(
      (candidate) => candidate.movementId === movement.movementId
    );
    if (settledIds.has(movement.movementId)) continue;
    if (existingIndex >= 0) {
      const existing = next[existingIndex];
      next[existingIndex] = observeVaultMovementCommit({
        ...existing,
        ...movement,
        observedOrder: existing?.observedOrder ?? movement.observedOrder,
      });
    } else {
      next.push(observeVaultMovementCommit(movement));
    }
  }
  return next.slice(-MAX_VISIBLE_VAULT_ACTIVITY);
}

/**
 * Stamp the incoming movements newest-first with their place in the page's
 * single activity order, ready for `mergeTrackedVaultMovements`. Shared by the
 * deposit and withdrawal watchers, whose stamping is otherwise line-for-line
 * identical. Pure apart from `nextOrder`, and called BEFORE the state updater
 * runs so the order advances exactly once per observed movement.
 */
function observeIncomingVaultMovements<Movement>(
  incoming: readonly Movement[],
  nextOrder: () => number
): (Movement & { observedOrder: number })[] {
  return [...incoming].reverse().map((movement) => ({
    ...movement,
    observedOrder: nextOrder(),
  }));
}

function provisionalVaultPosition(
  deposit: Pick<EarnVaultDepositRecord, "positionId"> & { createdAt?: string },
  custodyWalletId: string,
  strategy: EarnStrategy
): EarnVaultPosition | undefined {
  const shareMint = strategy.shareMint;
  const tokenMint = strategy.depositMints[0];
  if (!shareMint || !tokenMint) return undefined;
  return {
    id: deposit.positionId,
    provider: strategy.provider,
    providerReference: strategy.providerReference,
    label: strategy.name,
    custodyWalletId,
    tokenMint,
    shareMint,
    createdAt: deposit.createdAt ?? new Date().toISOString(),
    closedAt: null,
    feeSponsored: strategy.feeSponsored,
  };
}

interface EarnWithdrawalWatch {
  programId: string;
  withdrawalRef: string;
}

function withdrawalWatchKey(watch: EarnWithdrawalWatch): string {
  return `${watch.programId}:${watch.withdrawalRef}`;
}

/**
 * Recover only provider-accepted withdrawals that can still change. A
 * `requested` ledger row has no accepted provider operation to poll, and a row
 * without a provider reference cannot name the live resource without inventing
 * one. Duplicate references collapse to one tracker.
 */
function recoverableWithdrawalWatches(
  programId: string,
  withdrawals: readonly EarnProgramWithdrawalRecord[]
): EarnWithdrawalWatch[] {
  const seen = new Set<string>();
  const watches: EarnWithdrawalWatch[] = [];
  for (const withdrawal of withdrawals) {
    if (withdrawal.status !== "processing" && withdrawal.status !== "pending_approval") continue;
    const withdrawalRef = withdrawal.withdrawalRef;
    if (!withdrawalRef || withdrawalRef.trim() === "" || seen.has(withdrawalRef)) continue;
    seen.add(withdrawalRef);
    watches.push({ programId, withdrawalRef });
  }
  return watches;
}

function EarnWithdrawalLedgerRecovery({
  onRecover,
  programId,
}: {
  onRecover: (watches: readonly EarnWithdrawalWatch[]) => void;
  programId: string;
}) {
  const { withdrawals } = useEarnProgramWithdrawals(programId);

  useEffect(() => {
    if (!withdrawals) return;
    const watches = recoverableWithdrawalWatches(programId, withdrawals);
    if (watches.length > 0) onRecover(watches);
  }, [onRecover, programId, withdrawals]);

  return null;
}

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
  const { sdpEnvironment, selectedProjectId } = useDashboardWorkspace();
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
  const {
    state: programsState,
    error: programsError,
    isLoading: programsLoading,
    refresh: refreshPrograms,
  } = useEarnPrograms();
  const { deposits: discoveredVaultDeposits } = useEarnVaultDeposits();
  const { withdrawals: discoveredVaultWithdrawals } = useEarnVaultWithdrawals();
  const [depositStrategy, setDepositStrategy] = useState<EarnStrategy | null>(null);
  const [withdrawProgram, setWithdrawProgram] = useState<EarnProgram | null>(null);
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
  const [withdrawalWatches, setWithdrawalWatches] = useState<readonly EarnWithdrawalWatch[]>([]);
  const settledWithdrawalKeys = useRef(new Set<string>());
  const vaultActivityOrder = useRef(0);
  const [vaultDepositWatches, setVaultDepositWatches] = useState<readonly TrackedVaultDeposit[]>(
    []
  );
  const [settledVaultDepositIds, setSettledVaultDepositIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [vaultWithdrawalWatches, setVaultWithdrawalWatches] = useState<
    readonly TrackedVaultWithdrawal[]
  >([]);
  const [settledVaultWithdrawalIds, setSettledVaultWithdrawalIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );

  // Pure updater: the recovery list re-asserts every 30s, so this runs often
  // and must not have side effects (StrictMode double-invokes it in dev).
  const addVaultDepositWatches = useCallback(
    (incoming: readonly VaultDepositWatchInput[]) => {
      const observedIncoming = observeIncomingVaultMovements(
        incoming,
        () => ++vaultActivityOrder.current
      );
      setVaultDepositWatches((current) =>
        mergeTrackedVaultMovements(current, observedIncoming, settledVaultDepositIds)
      );
    },
    [settledVaultDepositIds]
  );

  // Same pure-updater and tombstone rules as the deposit watches above.
  const addVaultWithdrawalWatches = useCallback(
    (incoming: readonly VaultWithdrawalWatchInput[]) => {
      const observedIncoming = observeIncomingVaultMovements(
        incoming,
        () => ++vaultActivityOrder.current
      );
      setVaultWithdrawalWatches((current) =>
        mergeTrackedVaultMovements(current, observedIncoming, settledVaultWithdrawalIds)
      );
    },
    [settledVaultWithdrawalIds]
  );

  const addWithdrawalWatches = useCallback((incoming: readonly EarnWithdrawalWatch[]) => {
    setWithdrawalWatches((current) => {
      const known = new Set(current.map(withdrawalWatchKey));
      const additions = incoming.filter((watch) => {
        const key = withdrawalWatchKey(watch);
        if (known.has(key) || settledWithdrawalKeys.current.has(key)) return false;
        known.add(key);
        return true;
      });
      return additions.length === 0 ? current : [...current, ...additions];
    });
  }, []);

  const updateVaultDepositWatch = useCallback((updatedDeposit: EarnVaultDepositRecord) => {
    setVaultDepositWatches((current) => replaceTrackedVaultMovement(current, updatedDeposit));
  }, []);
  const updateVaultWithdrawalWatch = useCallback((updatedWithdrawal: EarnVaultWithdrawal) => {
    setVaultWithdrawalWatches((current) => replaceTrackedVaultMovement(current, updatedWithdrawal));
  }, []);

  const trackedActivities = useMemo(
    () => vaultActivities(vaultDepositWatches, vaultWithdrawalWatches),
    [vaultDepositWatches, vaultWithdrawalWatches]
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
    beginSubmission,
    refresh: refreshTreasuryBalances,
  } = useTreasuryBalances(trackedActivities);

  // A provisional row stands in only until the API lists the position itself.
  useEffect(() => {
    const listed = new Set(positions?.map((position) => position.id));
    setVaultDepositWatches((current) => {
      let changed = false;
      const next = current.map((deposit) => {
        if (deposit.provisionalPosition === undefined || !listed.has(deposit.positionId)) {
          return deposit;
        }
        changed = true;
        const { provisionalPosition: _, ...movement } = deposit;
        return movement;
      });
      return changed ? next : current;
    });
  }, [positions]);

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
  const programs = useMemo(
    () => (programsState?.kind === "ready" ? programsState.programs : []),
    [programsState]
  );
  // Recovery seeds durable component state. Do not derive tracker mounts
  // directly from the live list: the list can stop returning a movement just
  // before its detail poll observes terminal state, which would unmount the
  // tracker and skip `onSettled` balance refreshes and the final table status.
  useEffect(() => {
    addVaultDepositWatches((discoveredVaultDeposits ?? []).filter(isEarnVaultDepositInFlight));
  }, [addVaultDepositWatches, discoveredVaultDeposits]);
  useEffect(() => {
    addVaultWithdrawalWatches(
      (discoveredVaultWithdrawals ?? []).filter(isEarnVaultWithdrawalInFlight)
    );
  }, [addVaultWithdrawalWatches, discoveredVaultWithdrawals]);

  const activeVaultDepositWatches = useMemo(
    () => vaultDepositWatches.filter((deposit) => !settledVaultDepositIds.has(deposit.movementId)),
    [settledVaultDepositIds, vaultDepositWatches]
  );
  const activeVaultWithdrawalWatches = useMemo(
    () =>
      vaultWithdrawalWatches.filter(
        (withdrawal) => !settledVaultWithdrawalIds.has(withdrawal.movementId)
      ),
    [settledVaultWithdrawalIds, vaultWithdrawalWatches]
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
    refreshPrograms();
  };
  // A queued request settling moves holdings and cash, never the catalogue or a
  // custodial program, so it re-reads balances alone.
  const refreshHoldings = () => void refreshTreasuryBalances();

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
        onHoldingsChanged={refreshHoldings}
        onRefresh={refreshTreasury}
        onWithdrawPosition={openVaultExit}
        onWithdrawProgram={setWithdrawProgram}
        portfolioApy={portfolioApy}
        positions={positions}
        positionsFailed={Boolean(positionsError)}
        positionsLoading={positionsLoading}
        balanceOf={balanceOf}
        programs={programs}
        programsLoading={programsLoading}
        programsUnavailable={Boolean(programsError || programsState?.kind === "unconfigured")}
        providerAccess={providerAccess}
        summaryLoading={summaryLoading}
        balancesRefreshing={balancesRefreshing}
        vaultDeposits={vaultDepositWatches}
        vaultWithdrawals={vaultWithdrawalWatches}
        walletsFailed={Boolean(walletsError)}
        walletsLoading={walletsLoading}
      />

      {depositStrategy ? (
        <EarnVaultDepositModal
          onClose={() => setDepositStrategy(null)}
          projectId={selectedProjectId}
          onDeposited={(deposit, intent) => {
            // No balance read here: a read before the chain decides cannot show
            // the moved amount, and the position stays "updating" meanwhile.
            // The watch below triggers the one read that can, the
            // confirmation-floored refresh, including when this response is
            // already confirmed.
            const authoritativePosition = positions?.find(
              (position) => position.id === deposit.positionId
            );
            const provisionalPosition = authoritativePosition
              ? undefined
              : provisionalVaultPosition(deposit, intent.custodyWalletId, depositStrategy);
            addVaultDepositWatches([
              {
                failureReason: deposit.failureReason,
                movementId: deposit.movementId,
                positionId: deposit.positionId,
                provisionalPosition,
                status: deposit.status,
                submittedAt: intent.submittedAt,
                custodyWalletId: intent.custodyWalletId,
              },
            ]);
          }}
          onSubmissionStart={(custodyWalletId) =>
            beginSubmission({
              provider: depositStrategy.provider,
              providerReference: depositStrategy.providerReference,
              custodyWalletId,
            })
          }
          onMovementUpdated={updateVaultDepositWatch}
          strategy={depositStrategy}
        />
      ) : null}

      {withdrawProgram ? (
        <EarnWithdrawModal
          onClose={() => setWithdrawProgram(null)}
          onWithdrawalCreated={(withdrawalRef) => {
            addWithdrawalWatches([{ programId: withdrawProgram.id, withdrawalRef }]);
            refreshPrograms();
          }}
          provider={withdrawProgram.provider}
          programId={withdrawProgram.id}
        />
      ) : null}

      {withdrawPosition ? (
        <EarnVaultExitModal
          environment={sdpEnvironment}
          onClose={() => setWithdrawPosition(null)}
          onWithdrawn={(withdrawal, intent) => {
            // Like a deposit, the watch triggers the confirmation-floored read;
            // a read now would only fetch the pre-exit balance.
            addVaultWithdrawalWatches([
              {
                createdAt: withdrawal.createdAt,
                failureReason: withdrawal.failureReason,
                movementId: withdrawal.movementId,
                positionId: withdrawal.positionId,
                status: withdrawal.status,
                submittedAt: intent.submittedAt,
                custodyWalletId: withdrawPosition.custodyWalletId,
              },
            ]);
          }}
          onSubmissionStart={() => beginSubmission(withdrawPosition)}
          onMovementUpdated={updateVaultWithdrawalWatch}
          onAsyncRequest={() => {
            // An asynchronous request can move or escrow shares without paying
            // assets yet. Refresh holdings without projecting an instant exit.
            void refreshTreasuryBalances();
          }}
          onAsyncRequestSettled={refreshHoldings}
          parSource={withdrawParSource}
          position={withdrawPosition}
          projectId={selectedProjectId}
        />
      ) : null}

      {programs.map((program) => (
        <EarnWithdrawalLedgerRecovery
          key={`withdrawal-ledger:${program.id}`}
          onRecover={addWithdrawalWatches}
          programId={program.id}
        />
      ))}

      {activeVaultWithdrawalWatches.map((withdrawal) => (
        <EarnVaultWithdrawalOutcomeTracker
          key={`vault-withdrawal:${withdrawal.movementId}`}
          movementId={withdrawal.movementId}
          onUpdated={updateVaultWithdrawalWatch}
          onSettled={(settledWithdrawal) => {
            updateVaultWithdrawalWatch(settledWithdrawal);
            setSettledVaultWithdrawalIds((current) =>
              new Set(current).add(settledWithdrawal.movementId)
            );
            if (settledWithdrawal.status === "failed") void refreshTreasuryBalances();
          }}
        />
      ))}

      {activeVaultDepositWatches.map((deposit) => (
        <EarnVaultDepositOutcomeTracker
          key={`vault-deposit:${deposit.movementId}`}
          movementId={deposit.movementId}
          onUpdated={updateVaultDepositWatch}
          onSettled={(settledDeposit) => {
            updateVaultDepositWatch(settledDeposit);
            setSettledVaultDepositIds((current) => new Set(current).add(settledDeposit.movementId));
            if (settledDeposit.status === "failed") void refreshTreasuryBalances();
          }}
        />
      ))}

      {withdrawalWatches.map((watch) => (
        <EarnWithdrawalOutcomeTracker
          onSettled={() => {
            settledWithdrawalKeys.current.add(withdrawalWatchKey(watch));
            refreshPrograms();
            setWithdrawalWatches((current) =>
              current.filter(
                (candidate) =>
                  candidate.programId !== watch.programId ||
                  candidate.withdrawalRef !== watch.withdrawalRef
              )
            );
          }}
          key={withdrawalWatchKey(watch)}
          programId={watch.programId}
          withdrawalRef={watch.withdrawalRef}
        />
      ))}
    </DashboardWorkspaceOverviewPanel>
  );
}
