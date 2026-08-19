"use client";

import {
  type EarnProgramWithdrawalRecord,
  type EarnStrategy,
  type EarnVaultPosition,
  earnProgramSolanaPayoutTokens,
  isVaultDirectDepositEnabled,
  type SdpEnvironment,
} from "@sdp/types";
import {
  ArrowDownToLineIcon,
  ArrowUpFromLineIcon,
  InfoIcon,
  RefreshCwIcon,
  WalletCardsIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { TokenMark } from "@/components/token-mark";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ListEmptyState } from "@/components/ui/list-empty-state";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useLocale, useTranslations } from "@/i18n/provider";
import {
  type EarnFundingWallet,
  useEarnFundingWallets,
} from "../earn/deposit/earn-funding-wallets";
import {
  EarnStrategyIdentity,
  earnMintAsset,
  earnStrategyAsset,
  earnStrategyReferenceKey,
  formatProviderAmount,
  formatProviderApy,
  shortenMarketAddress,
  sumDecimalStrings,
} from "../earn/earn-market-presentation";
import {
  type EarnProgram,
  useEarnPrograms,
  useEarnProgramWithdrawals,
  useEarnStrategies,
  useEarnVaultPositions,
} from "../earn/earn-program-data";
import { type EarnProviderAccess, earnVaultDepositAvailability } from "../earn/earn-surfacing";
import { EarnVaultDepositModal } from "../earn/earn-vault-deposit-modal";
import { EarnWithdrawalOutcomeTracker, EarnWithdrawModal } from "../earn/earn-withdraw-modal";

function WalletBalanceList({ wallet }: { wallet: EarnFundingWallet }) {
  const t = useTranslations();
  const locale = useLocale();
  if (wallet.balances === undefined) {
    return (
      <p className="text-sm text-tertiary">{t("DashboardMarkets.treasury.balanceUnavailable")}</p>
    );
  }
  if (wallet.balances.length === 0) {
    return (
      <p className="text-sm text-tertiary">{t("DashboardMarkets.treasury.noTokenBalances")}</p>
    );
  }

  return (
    <dl className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {wallet.balances.map((balance) => (
        <div
          className="flex min-w-0 items-center gap-3 rounded-xl bg-fill-subtle px-4 py-3"
          key={`${wallet.id}:${balance.mint}`}
        >
          <TokenMark mint={balance.mint} size="sm" symbol={balance.token} />
          <div className="min-w-0">
            <dt className="truncate text-xs text-tertiary">{balance.token}</dt>
            <dd className="mt-0.5 truncate text-sm font-medium text-primary tabular-nums">
              {formatProviderAmount(balance.uiAmount, locale)}
            </dd>
          </div>
        </div>
      ))}
    </dl>
  );
}

function TreasuryWalletsCard({
  error,
  isLoading,
  wallets,
}: {
  error: unknown;
  isLoading: boolean;
  wallets: readonly EarnFundingWallet[];
}) {
  const t = useTranslations();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <WalletCardsIcon aria-hidden="true" className="size-5 text-secondary" />
          {t("DashboardMarkets.treasury.connectedWallets")}
        </CardTitle>
        <CardDescription>{t("DashboardMarkets.treasury.walletDescription")}</CardDescription>
        <CardAction>
          <Badge variant="outline">{t("DashboardMarkets.treasury.liveBalances")}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <SkeletonBlock className="h-28 rounded-xl" />
            <SkeletonBlock className="h-28 rounded-xl" />
          </div>
        ) : error ? (
          <p className="text-sm text-secondary">{t("DashboardMarkets.treasury.walletsError")}</p>
        ) : wallets.length === 0 ? (
          <ListEmptyState
            description={t("DashboardMarkets.treasury.walletsEmptyDescription")}
            icon={<WalletCardsIcon aria-hidden="true" className="size-5" />}
            message={t("DashboardMarkets.treasury.walletsEmptyTitle")}
          />
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {wallets.map((wallet) => (
              <section
                className="rounded-xl border border-border-default px-4 py-4"
                key={wallet.id}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-medium text-primary">
                      {wallet.label?.trim() || t("DashboardMarkets.treasury.unnamedWallet")}
                    </h3>
                    <p className="mt-1 text-xs text-tertiary" title={wallet.publicKey}>
                      {shortenMarketAddress(wallet.publicKey)}
                    </p>
                  </div>
                  <Badge variant={wallet.isRuntimeExecutionAllowed ? "success" : "outline"}>
                    {wallet.provider ?? t("DashboardMarkets.treasury.walletProviderUnknown")}
                  </Badge>
                </div>
                <WalletBalanceList wallet={wallet} />
              </section>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function strategyPositionValue(
  strategy: EarnStrategy,
  positions: readonly EarnVaultPosition[] | undefined
): { count: number; value?: string } {
  const active = (positions ?? []).filter(
    (position) =>
      position.closedAt === null &&
      earnStrategyReferenceKey(position.provider, position.providerReference) ===
        earnStrategyReferenceKey(strategy.provider, strategy.providerReference)
  );
  if (active.length === 0) return { count: 0 };
  const values = active.map((position) => position.tokenValue);
  if (values.some((value) => value === undefined)) return { count: active.length };
  return { count: active.length, value: sumDecimalStrings(values as string[]) };
}

function StrategyTable({
  environment,
  onDeposit,
  positions,
  providerAccess,
  strategies,
}: {
  environment: SdpEnvironment;
  onDeposit: (strategy: EarnStrategy) => void;
  positions: readonly EarnVaultPosition[] | undefined;
  providerAccess: EarnProviderAccess | null;
  strategies: readonly EarnStrategy[];
}) {
  const t = useTranslations();
  const locale = useLocale();

  return (
    <div className="overflow-x-auto border-t border-border-subtle">
      <Table className="table-fixed" style={{ minWidth: "62rem" }}>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[31%]">{t("DashboardMarkets.treasury.strategy")}</TableHead>
            <TableHead className="w-[12%]">{t("DashboardMarkets.treasury.asset")}</TableHead>
            <TableHead className="w-[13%]">{t("DashboardMarkets.treasury.apy")}</TableHead>
            <TableHead className="w-[17%]">{t("DashboardMarkets.treasury.balance")}</TableHead>
            <TableHead className="w-[13%]">{t("DashboardMarkets.treasury.status")}</TableHead>
            <TableHead align="right" className="w-[14%]">
              {t("DashboardMarkets.treasury.actions")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {strategies.map((strategy) => {
            const asset = earnStrategyAsset(strategy);
            const position = positions ? strategyPositionValue(strategy, positions) : null;
            const availability = earnVaultDepositAvailability(
              strategy,
              environment,
              providerAccess
            );
            const canDeposit = availability === "available";
            return (
              <TableRow key={strategy.id}>
                <TableCell>
                  <EarnStrategyIdentity strategy={strategy} />
                </TableCell>
                <TableCell className="text-sm text-secondary">{asset?.symbol ?? "—"}</TableCell>
                <TableCell className="text-lg font-medium text-primary tabular-nums">
                  {formatProviderApy(strategy.currentApy, locale)}
                </TableCell>
                <TableCell>
                  <p className="text-sm text-primary tabular-nums">
                    {position === null
                      ? "—"
                      : position.count === 0
                        ? t("DashboardMarkets.treasury.noBalance")
                        : formatProviderAmount(position.value, locale, asset?.symbol)}
                  </p>
                  {position === null || (position.count > 0 && position.value === undefined) ? (
                    <p className="mt-1 text-xs text-tertiary">
                      {t("DashboardMarkets.treasury.positionValueUnavailable")}
                    </p>
                  ) : null}
                </TableCell>
                <TableCell>
                  <Badge variant={canDeposit ? "default" : "outline"}>
                    {t(
                      availability === "available"
                        ? "DashboardMarkets.treasury.depositAvailable"
                        : availability === "environment_unavailable"
                          ? "DashboardMarkets.treasury.productionUnavailable"
                          : availability === "access_unavailable"
                            ? "DashboardMarkets.treasury.accessUnavailable"
                            : availability === "provider_unavailable"
                              ? "DashboardMarkets.treasury.providerUnavailable"
                              : "DashboardMarkets.treasury.depositUnavailable"
                    )}
                  </Badge>
                </TableCell>
                <TableCell align="right">
                  <div className="flex justify-end gap-2">
                    <Button
                      disabled={!canDeposit}
                      iconLeft={<ArrowDownToLineIcon />}
                      onClick={() => onDeposit(strategy)}
                      size="sm"
                      type="button"
                    >
                      {t("DashboardMarkets.treasury.deposit")}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function ActiveVaultPositionsCard({
  error,
  isLoading,
  positions,
  wallets,
}: {
  error: unknown;
  isLoading: boolean;
  positions: readonly EarnVaultPosition[] | undefined;
  wallets: readonly EarnFundingWallet[];
}) {
  const t = useTranslations();
  const locale = useLocale();
  const activePositions = (positions ?? []).filter((position) => position.closedAt === null);
  const walletById = new Map(wallets.map((wallet) => [wallet.id, wallet] as const));

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle>{t("DashboardMarkets.treasury.vaultPositionsTitle")}</CardTitle>
        <CardDescription>
          {t("DashboardMarkets.treasury.vaultPositionsDescription")}
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        {isLoading ? (
          <div className="grid gap-3 px-6 py-5">
            <SkeletonBlock className="h-14 rounded-xl" />
            <SkeletonBlock className="h-14 rounded-xl" />
          </div>
        ) : error ? (
          <ListEmptyState
            description={t("DashboardMarkets.treasury.vaultPositionsErrorDescription")}
            icon={<InfoIcon aria-hidden="true" className="size-5" />}
            message={t("DashboardMarkets.treasury.vaultPositionsErrorTitle")}
          />
        ) : activePositions.length === 0 ? (
          <ListEmptyState
            description={t("DashboardMarkets.treasury.vaultPositionsEmptyDescription")}
            icon={<WalletCardsIcon aria-hidden="true" className="size-5" />}
            message={t("DashboardMarkets.treasury.vaultPositionsEmptyTitle")}
          />
        ) : (
          <>
            <div className="overflow-x-auto border-y border-border-subtle">
              <Table className="table-fixed" style={{ minWidth: "58rem" }}>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[28%]">
                      {t("DashboardMarkets.treasury.position")}
                    </TableHead>
                    <TableHead className="w-[12%]">
                      {t("DashboardMarkets.treasury.asset")}
                    </TableHead>
                    <TableHead className="w-[16%]">
                      {t("DashboardMarkets.treasury.balance")}
                    </TableHead>
                    <TableHead className="w-[14%]">
                      {t("DashboardMarkets.treasury.shares")}
                    </TableHead>
                    <TableHead className="w-[18%]">
                      {t("DashboardMarkets.treasury.custodyWallet")}
                    </TableHead>
                    <TableHead align="right" className="w-[12%]">
                      {t("DashboardMarkets.treasury.actions")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {activePositions.map((position) => {
                    const asset = earnMintAsset(position.tokenMint);
                    const wallet = walletById.get(position.custodyWalletId);
                    return (
                      <TableRow key={position.id}>
                        <TableCell>
                          <p className="truncate text-sm text-primary" title={position.label}>
                            {position.label || shortenMarketAddress(position.providerReference)}
                          </p>
                          <p className="mt-0.5 truncate text-xs text-tertiary">
                            {position.provider}
                          </p>
                        </TableCell>
                        <TableCell className="text-sm text-secondary">{asset.symbol}</TableCell>
                        <TableCell className="text-sm text-primary tabular-nums">
                          {formatProviderAmount(position.tokenValue, locale, asset.symbol)}
                        </TableCell>
                        <TableCell className="text-sm text-secondary tabular-nums">
                          {formatProviderAmount(position.shares, locale)}
                        </TableCell>
                        <TableCell className="text-sm text-secondary">
                          {wallet?.label?.trim() ||
                            shortenMarketAddress(wallet?.publicKey ?? position.custodyWalletId)}
                        </TableCell>
                        <TableCell align="right">
                          {/*
                           * There is no vault-withdraw HTTP route or provider capability yet.
                           * Keep the verb visible so the missing exit is explicit, but never
                           * attach a client-only balance mutation or expose a raw vault address.
                           */}
                          <Button
                            aria-describedby="earn-vault-withdraw-unavailable-note"
                            disabled
                            iconLeft={<ArrowUpFromLineIcon />}
                            size="sm"
                            title={t("DashboardMarkets.treasury.vaultWithdrawUnavailable")}
                            type="button"
                            variant="secondary"
                          >
                            {t("DashboardMarkets.treasury.withdraw")}
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            <div
              className="flex items-start gap-2 bg-fill-subtle px-6 py-3 text-xs leading-5 text-secondary"
              id="earn-vault-withdraw-unavailable-note"
            >
              <InfoIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <p>{t("DashboardMarkets.treasury.vaultWithdrawUnavailable")}</p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function programName(program: EarnProgram, fallback: string): string {
  const positionName = program.wallet.positions.find(
    (position) => position.kind === "yield_source"
  )?.label;
  return program.label?.trim() || positionName?.trim() || fallback;
}

function ExistingProgramsCard({
  programs,
  onWithdraw,
}: {
  programs: readonly EarnProgram[];
  onWithdraw: (program: EarnProgram) => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  if (programs.length === 0) return null;

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle>{t("DashboardMarkets.treasury.existingProgramsTitle")}</CardTitle>
        <CardDescription>
          {t("DashboardMarkets.treasury.existingProgramsDescription")}
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <div className="overflow-x-auto border-t border-border-subtle">
          <Table className="table-fixed" style={{ minWidth: "48rem" }}>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[34%]">{t("DashboardMarkets.treasury.strategy")}</TableHead>
                <TableHead className="w-[18%]">{t("DashboardMarkets.treasury.provider")}</TableHead>
                <TableHead className="w-[18%]">{t("DashboardMarkets.treasury.balance")}</TableHead>
                <TableHead className="w-[16%]">{t("DashboardMarkets.treasury.status")}</TableHead>
                <TableHead align="right" className="w-[14%]">
                  {t("DashboardMarkets.treasury.actions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {programs.map((program) => {
                const withdrawalAvailable =
                  earnProgramSolanaPayoutTokens(program.provider).length > 0;
                return (
                  <TableRow key={program.id}>
                    <TableCell className="text-sm text-primary">
                      {programName(program, t("DashboardMarkets.treasury.unnamedProgram"))}
                    </TableCell>
                    <TableCell className="text-sm text-secondary">{program.provider}</TableCell>
                    <TableCell className="text-sm text-primary tabular-nums">
                      {formatProviderAmount(
                        program.wallet.balance.totalUsd,
                        locale,
                        t("DashboardMarkets.treasury.usdSymbol"),
                        2,
                        2
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={program.wallet.status === "failed" ? "danger" : "outline"}>
                        {program.wallet.status}
                      </Badge>
                    </TableCell>
                    <TableCell align="right">
                      <div className="flex flex-col items-end gap-1.5">
                        {/* An open provider id may outlive its runtime capability.
                            Never open a provider-specific withdrawal form unless
                            the shared contract declares a Solana payout lane. */}
                        <Button
                          data-earn-withdraw-focus-fallback={program.id}
                          disabled={program.wallet.status === "creating" || !withdrawalAvailable}
                          iconLeft={<ArrowUpFromLineIcon />}
                          onClick={() => onWithdraw(program)}
                          size="sm"
                          type="button"
                          variant="secondary"
                        >
                          {t("DashboardMarkets.treasury.withdraw")}
                        </Button>
                        {!withdrawalAvailable ? (
                          <span className="text-[11px] leading-4 text-tertiary">
                            {t("DashboardMarkets.treasury.providerWithdrawalUnavailable")}
                          </span>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        <div className="flex items-start gap-2 bg-fill-subtle px-6 py-3 text-xs leading-5 text-secondary">
          <InfoIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {/* Ground can require customer-side approval, but SDP has no
           * provider-approval route or signer UI yet. Never imply the
           * dashboard can release a withdrawal that is parked there. */}
          <p>{t("DashboardMarkets.treasury.withdrawalApprovalUnavailable")}</p>
        </div>
      </CardContent>
    </Card>
  );
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

export function TreasurySolutionsWorkspace({
  providerAccess,
}: {
  providerAccess: EarnProviderAccess | null;
}) {
  const t = useTranslations();
  const { sdpEnvironment } = useDashboardWorkspace();
  const {
    wallets,
    error: walletsError,
    isLoading: walletsLoading,
    refresh: refreshWallets,
  } = useEarnFundingWallets();
  const {
    strategies,
    error: strategiesError,
    isLoading: strategiesLoading,
    refresh: refreshStrategies,
  } = useEarnStrategies();
  const {
    positions,
    error: positionsError,
    isLoading: positionsLoading,
    refresh: refreshPositions,
  } = useEarnVaultPositions();
  const {
    state: programsState,
    error: programsError,
    isLoading: programsLoading,
    refresh: refreshPrograms,
  } = useEarnPrograms();
  const [depositStrategy, setDepositStrategy] = useState<EarnStrategy | null>(null);
  const [withdrawProgram, setWithdrawProgram] = useState<EarnProgram | null>(null);
  const [withdrawalWatches, setWithdrawalWatches] = useState<readonly EarnWithdrawalWatch[]>([]);
  const settledWithdrawalKeys = useRef(new Set<string>());

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

  const activeWallets = wallets ?? [];
  const programs = programsState?.kind === "ready" ? programsState.programs : [];
  const depositsEnabled = isVaultDirectDepositEnabled(sdpEnvironment);

  return (
    <DashboardWorkspaceOverviewPanel>
      <div className="mx-auto w-full max-w-7xl space-y-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-3xl">
            <p className="text-xs font-medium uppercase tracking-wide text-tertiary">
              {t("DashboardMarkets.treasury.eyebrow")}
            </p>
            <p className="mt-2 text-sm leading-6 text-secondary">
              {t("DashboardMarkets.treasury.description")}
            </p>
          </div>
          <Badge variant={sdpEnvironment === "sandbox" ? "default" : "outline"}>
            {sdpEnvironment}
          </Badge>
        </div>

        <TreasuryWalletsCard
          error={walletsError}
          isLoading={walletsLoading}
          wallets={activeWallets}
        />

        <ActiveVaultPositionsCard
          error={positionsError}
          isLoading={positionsLoading}
          positions={positions}
          wallets={activeWallets}
        />

        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle>{t("DashboardMarkets.treasury.strategiesTitle")}</CardTitle>
            <CardDescription>
              {t("DashboardMarkets.treasury.strategiesDescription")}
            </CardDescription>
            <CardAction>
              <Button
                iconLeft={<RefreshCwIcon />}
                onClick={() => {
                  refreshWallets();
                  refreshStrategies();
                  refreshPositions();
                  refreshPrograms();
                }}
                size="sm"
                type="button"
                variant="ghost"
              >
                {t("DashboardMarkets.treasury.refresh")}
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="px-0">
            {strategiesLoading ? (
              <div className="grid gap-3 px-6 py-5">
                <SkeletonBlock className="h-14 rounded-xl" />
                <SkeletonBlock className="h-14 rounded-xl" />
                <SkeletonBlock className="h-14 rounded-xl" />
              </div>
            ) : strategiesError ? (
              <ListEmptyState
                description={t("DashboardMarkets.treasury.strategiesErrorDescription")}
                icon={<InfoIcon aria-hidden="true" className="size-5" />}
                message={t("DashboardMarkets.treasury.strategiesErrorTitle")}
              />
            ) : (strategies ?? []).length === 0 ? (
              <ListEmptyState
                description={t("DashboardMarkets.treasury.strategiesEmptyDescription")}
                icon={<InfoIcon aria-hidden="true" className="size-5" />}
                message={t("DashboardMarkets.treasury.strategiesEmptyTitle")}
              />
            ) : (
              <StrategyTable
                environment={sdpEnvironment}
                onDeposit={setDepositStrategy}
                positions={positions}
                providerAccess={providerAccess}
                strategies={strategies ?? []}
              />
            )}
            <div className="flex items-start gap-2 border-t border-border-subtle px-6 py-4 text-xs leading-5 text-tertiary">
              <InfoIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <p>
                {t(
                  providerAccess === null
                    ? "DashboardMarkets.treasury.accessDisclosure"
                    : depositsEnabled
                      ? "DashboardMarkets.treasury.rateDisclosure"
                      : "DashboardMarkets.treasury.productionDisclosure"
                )}
              </p>
            </div>
          </CardContent>
        </Card>

        {programsLoading ? <SkeletonBlock className="h-48 rounded-xl" /> : null}
        {programsError || programsState?.kind === "unconfigured" ? (
          <Card className="px-6 py-5">
            <p className="text-sm text-secondary">
              {t("DashboardMarkets.treasury.existingProgramsUnavailable")}
            </p>
          </Card>
        ) : (
          <ExistingProgramsCard programs={programs} onWithdraw={setWithdrawProgram} />
        )}
      </div>

      {depositStrategy ? (
        <EarnVaultDepositModal
          onClose={() => setDepositStrategy(null)}
          onDeposited={() => {
            refreshPositions();
            refreshWallets();
          }}
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

      {programs.map((program) => (
        <EarnWithdrawalLedgerRecovery
          key={`withdrawal-ledger:${program.id}`}
          onRecover={addWithdrawalWatches}
          programId={program.id}
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
