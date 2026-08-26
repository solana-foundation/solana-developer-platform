"use client";

import {
  type EarnProgramWithdrawalRecord,
  type EarnStrategy,
  type EarnVaultPosition,
  earnProgramSolanaPayoutTokens,
  isVaultDirectDepositEnabled,
  type SdpEnvironment,
  WELL_KNOWN_TOKEN_BY_MINT,
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
import { formatUsd } from "../earn/earn-format";
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
  isEarnVaultDepositInFlight,
  isEarnVaultWithdrawalInFlight,
  useEarnPrograms,
  useEarnProgramWithdrawals,
  useEarnStrategies,
  useEarnVaultDeposits,
  useEarnVaultPositions,
  useEarnVaultWithdrawals,
} from "../earn/earn-program-data";
import { type EarnProviderAccess, earnVaultDepositAvailability } from "../earn/earn-surfacing";
import {
  EarnVaultDepositModal,
  EarnVaultDepositOutcomeTracker,
} from "../earn/earn-vault-deposit-modal";
import {
  EarnVaultWithdrawalOutcomeTracker,
  EarnVaultWithdrawModal,
} from "../earn/earn-vault-withdraw-modal";
import { EarnWithdrawalOutcomeTracker, EarnWithdrawModal } from "../earn/earn-withdraw-modal";
import {
  formatAllocationShare,
  isOpenVaultPosition,
  summarizeTreasuryAllocation,
  type TreasuryAllocation,
  type VaultShareMintVocabulary,
} from "./treasury-allocation";

function AllocationFigure({
  caption,
  label,
  value,
}: {
  caption: string;
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-tertiary">{label}</dt>
      {/* Numbers never truncate; a figure too wide for its column wraps
       * instead of painting over the neighbour. */}
      <dd className="mt-1.5 text-2xl leading-8 font-medium text-primary tabular-nums [overflow-wrap:anywhere]">
        {value}
      </dd>
      <dd className="mt-1 text-xs text-tertiary">{caption}</dd>
    </div>
  );
}

function TreasuryAllocationCard({
  allocation,
  isLoading,
}: {
  allocation: TreasuryAllocation;
  isLoading: boolean;
}) {
  const t = useTranslations();
  const locale = useLocale();

  if (isLoading) {
    return (
      <Card>
        <CardContent className="grid gap-6 sm:grid-cols-3">
          <SkeletonBlock className="h-20 rounded-xl" />
          <SkeletonBlock className="h-20 rounded-xl" />
          <SkeletonBlock className="h-20 rounded-xl" />
        </CardContent>
      </Card>
    );
  }

  const summary = allocation;

  return (
    <Card>
      <CardContent>
        <dl className="grid gap-x-6 gap-y-5 sm:grid-cols-3">
          <AllocationFigure
            caption={t(
              summary.availableCash === undefined
                ? "DashboardMarkets.treasury.summaryCashUnavailable"
                : "DashboardMarkets.treasury.summaryCashCaption"
            )}
            label={t("DashboardMarkets.treasury.summaryCash")}
            value={formatUsd(summary.availableCash, locale, 2)}
          />
          <AllocationFigure
            caption={
              summary.deployedValue !== undefined
                ? t("DashboardMarkets.treasury.summaryDeployedCaption", {
                    value: formatUsd(summary.deployedValue, locale, 2),
                  })
                : t(
                    summary.deployedAbsence === "unreconciled"
                      ? "DashboardMarkets.treasury.summaryDeployedUnreconciled"
                      : "DashboardMarkets.treasury.summaryDeployedUnavailable"
                  )
            }
            label={t("DashboardMarkets.treasury.summaryDeployed")}
            value={formatAllocationShare(summary.deployedShare, locale)}
          />
          <AllocationFigure
            caption={t(
              summary.remainingShare !== undefined
                ? "DashboardMarkets.treasury.summaryRemainingCaption"
                : summary.sharesAbsence === "empty_float"
                  ? "DashboardMarkets.treasury.summaryEmptyFloat"
                  : "DashboardMarkets.treasury.summaryShareUnavailable"
            )}
            label={t("DashboardMarkets.treasury.summaryRemaining")}
            value={formatAllocationShare(summary.remainingShare, locale)}
          />
        </dl>
        {summary.deployedShare !== undefined ? (
          /* The share stays a decimal string end to end; calc() does the
           * width multiplication so no Number cast touches the amount. */
          <div
            aria-hidden="true"
            className="mt-5 h-1.5 w-full overflow-hidden rounded-full bg-fill-strong"
            data-testid="treasury-allocation-bar"
          >
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `calc(${summary.deployedShare} * 100%)` }}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function WalletBalanceList({
  vaultShareMints,
  wallet,
}: {
  vaultShareMints: ReadonlySet<string>;
  wallet: EarnFundingWallet;
}) {
  const t = useTranslations();
  const locale = useLocale();
  if (wallet.balances === undefined) {
    return (
      <p className="text-sm text-tertiary">{t("DashboardMarkets.treasury.balanceUnavailable")}</p>
    );
  }
  // Vault share (receipt) tokens are ownership, not cash: they render as the
  // wallet's "deployed in vaults" line and as position rows below, never as a
  // token tile with an unreadable mint-derived symbol.
  const cashBalances = wallet.balances.filter((balance) => !vaultShareMints.has(balance.mint));
  if (cashBalances.length === 0) {
    return (
      <p className="text-sm text-tertiary">{t("DashboardMarkets.treasury.noTokenBalances")}</p>
    );
  }

  return (
    <ul className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {cashBalances.map((balance) => (
        <li
          className="flex min-w-0 items-center gap-3 rounded-xl bg-fill-subtle px-4 py-3"
          key={`${wallet.id}:${balance.mint}`}
        >
          <TokenMark mint={balance.mint} size="sm" symbol={balance.token} />
          <div className="min-w-0">
            <p className="truncate text-xs text-tertiary">{balance.token}</p>
            <p className="mt-0.5 truncate text-sm font-medium text-primary tabular-nums">
              {formatProviderAmount(balance.uiAmount, locale)}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}

function TreasuryWalletsCard({
  allocation,
  error,
  isLoading,
  shareMints,
  wallets,
}: {
  allocation: TreasuryAllocation;
  error: unknown;
  isLoading: boolean;
  shareMints: VaultShareMintVocabulary;
  wallets: readonly EarnFundingWallet[];
}) {
  const t = useTranslations();
  const locale = useLocale();
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
            {wallets.map((wallet) => {
              // Straight from the same result the summary rendered, so the
              // two cannot disagree about this wallet.
              const deployment = allocation.deploymentByWalletId.get(wallet.id) ?? {
                kind: "none" as const,
              };
              return (
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
                  <WalletBalanceList vaultShareMints={shareMints.known} wallet={wallet} />
                  {deployment.kind !== "none" ? (
                    <div className="mt-3 flex items-center justify-between gap-4 border-t border-border-subtle pt-3">
                      <span className="text-xs text-tertiary">
                        {t("DashboardMarkets.treasury.walletDeployed")}
                      </span>
                      <span className="text-sm font-medium text-primary tabular-nums">
                        {deployment.kind === "value"
                          ? formatUsd(deployment.value, locale, 2)
                          : t("DashboardMarkets.treasury.positionValueUnavailable")}
                      </span>
                    </div>
                  ) : null}
                </section>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function strategyPositionValue(
  strategy: EarnStrategy,
  positions: readonly EarnVaultPosition[] | undefined,
  /** Undefined when the witness is unavailable, so nothing can be certified. */
  unrecordedShareMints: ReadonlySet<string> | undefined
): { count: number; unrecorded?: boolean; value?: string } {
  const active = (positions ?? []).filter(
    (position) =>
      isOpenVaultPosition(position) &&
      earnStrategyReferenceKey(position.provider, position.providerReference) ===
        earnStrategyReferenceKey(strategy.provider, strategy.providerReference)
  );
  // Applies to a row WITH recorded positions too, not just an empty one: a
  // second wallet holding this vault's shares with no row behind them makes
  // the recorded figure a floor, and printing it would contradict the summary
  // and that wallet's card, which both read unavailable here. Without the
  // witness at all, "no active position" is equally unsupportable.
  const unrecorded =
    unrecordedShareMints === undefined ||
    (strategy.shareMint !== undefined && unrecordedShareMints.has(strategy.shareMint));
  if (unrecorded) return { count: active.length, unrecorded };
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
  unrecordedShareMints,
}: {
  environment: SdpEnvironment;
  onDeposit: (strategy: EarnStrategy) => void;
  positions: readonly EarnVaultPosition[] | undefined;
  providerAccess: EarnProviderAccess | null;
  strategies: readonly EarnStrategy[];
  unrecordedShareMints: ReadonlySet<string> | undefined;
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
            const position = positions
              ? strategyPositionValue(strategy, positions, unrecordedShareMints)
              : null;
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
                    {position === null || position.unrecorded
                      ? "—"
                      : position.count === 0
                        ? t("DashboardMarkets.treasury.noBalance")
                        : formatProviderAmount(position.value, locale, asset?.symbol)}
                  </p>
                  {position === null ||
                  position.unrecorded ||
                  (position.count > 0 && position.value === undefined) ? (
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
  onWithdraw,
  positions,
  unrecordedShareMints,
  wallets,
}: {
  error: unknown;
  isLoading: boolean;
  onWithdraw: (position: EarnVaultPosition) => void;
  positions: readonly EarnVaultPosition[] | undefined;
  unrecordedShareMints: ReadonlySet<string> | undefined;
  wallets: readonly EarnFundingWallet[];
}) {
  const t = useTranslations();
  const locale = useLocale();
  const activePositions = (positions ?? []).filter(isOpenVaultPosition);
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
          // "No positions" is a claim of ABSENCE, so it needs the same witness
          // every other surface needs. Receipt tokens with no row behind them,
          // or a witness that could not be built, mean holdings may exist that
          // this list cannot show.
          unrecordedShareMints === undefined || unrecordedShareMints.size > 0 ? (
            <ListEmptyState
              description={t("DashboardMarkets.treasury.vaultPositionsIncompleteDescription")}
              icon={<InfoIcon aria-hidden="true" className="size-5" />}
              message={t("DashboardMarkets.treasury.vaultPositionsIncompleteTitle")}
            />
          ) : (
            <ListEmptyState
              description={t("DashboardMarkets.treasury.vaultPositionsEmptyDescription")}
              icon={<WalletCardsIcon aria-hidden="true" className="size-5" />}
              message={t("DashboardMarkets.treasury.vaultPositionsEmptyTitle")}
            />
          )
        ) : (
          <div className="overflow-x-auto border-y border-border-subtle">
            <Table className="table-fixed" style={{ minWidth: "52rem" }}>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[32%]">
                    {t("DashboardMarkets.treasury.position")}
                  </TableHead>
                  <TableHead className="w-[12%]">{t("DashboardMarkets.treasury.asset")}</TableHead>
                  <TableHead className="w-[20%]">
                    {t("DashboardMarkets.treasury.balance")}
                  </TableHead>
                  <TableHead className="w-[22%]">
                    {t("DashboardMarkets.treasury.custodyWallet")}
                  </TableHead>
                  <TableHead align="right" className="w-[14%]">
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
                        <p className="mt-0.5 truncate text-xs text-tertiary">{position.provider}</p>
                      </TableCell>
                      <TableCell className="text-sm text-secondary">{asset.symbol}</TableCell>
                      <TableCell className="text-sm text-primary tabular-nums">
                        {formatProviderAmount(position.tokenValue, locale, asset.symbol)}
                      </TableCell>
                      <TableCell className="text-sm text-secondary">
                        {wallet?.label?.trim() ||
                          shortenMarketAddress(wallet?.publicKey ?? position.custodyWalletId)}
                      </TableCell>
                      <TableCell align="right">
                        {/*
                         * The exit route (PRO-1702). Deliberately NOT gated on
                         * availability, surfacing, or environment — money out
                         * beats money off (ADR 0002), so the verb stays live
                         * wherever a position exists. A provider whose exit
                         * SDP cannot build yet answers 501 with a clear error
                         * inside the modal rather than a silently dead button.
                         */}
                        <Button
                          data-earn-vault-withdraw-focus-fallback={position.id}
                          iconLeft={<ArrowUpFromLineIcon />}
                          onClick={() => onWithdraw(position)}
                          size="sm"
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

function TreasuryStrategiesCard({
  environment,
  error,
  isLoading,
  onDeposit,
  onRefresh,
  positions,
  providerAccess,
  strategies,
  unrecordedShareMints,
}: {
  environment: SdpEnvironment;
  error: unknown;
  isLoading: boolean;
  onDeposit: (strategy: EarnStrategy) => void;
  onRefresh: () => void;
  positions: readonly EarnVaultPosition[] | undefined;
  providerAccess: EarnProviderAccess | null;
  strategies: readonly EarnStrategy[] | undefined;
  unrecordedShareMints: ReadonlySet<string> | undefined;
}) {
  const t = useTranslations();
  const depositsEnabled = isVaultDirectDepositEnabled(environment);

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle>{t("DashboardMarkets.treasury.strategiesTitle")}</CardTitle>
        <CardDescription>{t("DashboardMarkets.treasury.strategiesDescription")}</CardDescription>
        <CardAction>
          <Button
            iconLeft={<RefreshCwIcon />}
            onClick={onRefresh}
            size="sm"
            type="button"
            variant="ghost"
          >
            {t("DashboardMarkets.treasury.refresh")}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="px-0">
        {isLoading ? (
          <div className="grid gap-3 px-6 py-5">
            <SkeletonBlock className="h-14 rounded-xl" />
            <SkeletonBlock className="h-14 rounded-xl" />
            <SkeletonBlock className="h-14 rounded-xl" />
          </div>
        ) : error ? (
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
            environment={environment}
            onDeposit={onDeposit}
            positions={positions}
            providerAccess={providerAccess}
            strategies={strategies ?? []}
            unrecordedShareMints={unrecordedShareMints}
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
  );
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
  const { sdpEnvironment, selectedProjectId } = useDashboardWorkspace();
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
  const { deposits: discoveredVaultDeposits } = useEarnVaultDeposits();
  const { withdrawals: discoveredVaultWithdrawals } = useEarnVaultWithdrawals();
  const [depositStrategy, setDepositStrategy] = useState<EarnStrategy | null>(null);
  const [withdrawProgram, setWithdrawProgram] = useState<EarnProgram | null>(null);
  const [withdrawPosition, setWithdrawPosition] = useState<EarnVaultPosition | null>(null);
  const [withdrawalWatches, setWithdrawalWatches] = useState<readonly EarnWithdrawalWatch[]>([]);
  const settledWithdrawalKeys = useRef(new Set<string>());
  const [vaultDepositWatches, setVaultDepositWatches] = useState<readonly string[]>([]);
  const [settledVaultDepositIds, setSettledVaultDepositIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [vaultWithdrawalWatches, setVaultWithdrawalWatches] = useState<readonly string[]>([]);
  const [settledVaultWithdrawalIds, setSettledVaultWithdrawalIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );

  // Pure updater: the recovery list re-asserts every 30s, so this runs often
  // and must not have side effects (StrictMode double-invokes it in dev).
  const addVaultDepositWatches = useCallback(
    (incoming: readonly string[]) => {
      setVaultDepositWatches((current) => {
        const known = new Set(current);
        const additions = incoming.filter((movementId) => {
          // `settledVaultDepositIds` is load-bearing, not defensive: the ledger
          // list keeps re-asserting a row until the server marks it terminal, so
          // without a tombstone a just-settled deposit would be resurrected on
          // the next pass and announced again.
          if (known.has(movementId) || settledVaultDepositIds.has(movementId)) return false;
          known.add(movementId);
          return true;
        });
        return additions.length === 0 ? current : [...current, ...additions];
      });
    },
    [settledVaultDepositIds]
  );

  // Same pure-updater and tombstone rules as the deposit watches above.
  const addVaultWithdrawalWatches = useCallback(
    (incoming: readonly string[]) => {
      setVaultWithdrawalWatches((current) => {
        const known = new Set(current);
        const additions = incoming.filter((movementId) => {
          if (known.has(movementId) || settledVaultWithdrawalIds.has(movementId)) {
            return false;
          }
          known.add(movementId);
          return true;
        });
        return additions.length === 0 ? current : [...current, ...additions];
      });
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

  const activeWallets = wallets ?? [];
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
  const shareMints = {
    known: new Set(
      [
        ...(positions ?? []).map((position) => position.shareMint),
        ...(strategies ?? []).flatMap((strategy) => strategy.shareMint ?? []),
      ].filter((mint) => !WELL_KNOWN_TOKEN_BY_MINT.get(mint)?.isUsdStable)
    ),
    complete:
      strategies !== undefined &&
      !strategiesError &&
      strategies.every((strategy) => strategy.shareMint !== undefined),
  };
  // Every figure on this page comes from here, so no two surfaces can compute
  // the same thing differently.
  const allocation = summarizeTreasuryAllocation({
    positions: positionsError ? undefined : positions,
    shareMints,
    wallets: walletsError ? undefined : wallets,
  });
  const programs = programsState?.kind === "ready" ? programsState.programs : [];
  // Recovery seeds durable component state. Do not derive tracker mounts
  // directly from the live list: the list can stop returning a movement just
  // before its detail poll observes terminal state, which would unmount the
  // tracker and skip `onSettled` balance refreshes and outcome messaging.
  useEffect(() => {
    addVaultDepositWatches(
      (discoveredVaultDeposits ?? []).flatMap((deposit) =>
        isEarnVaultDepositInFlight(deposit) ? [deposit.movementId] : []
      )
    );
  }, [addVaultDepositWatches, discoveredVaultDeposits]);
  useEffect(() => {
    addVaultWithdrawalWatches(
      (discoveredVaultWithdrawals ?? []).flatMap((withdrawal) =>
        isEarnVaultWithdrawalInFlight(withdrawal) ? [withdrawal.movementId] : []
      )
    );
  }, [addVaultWithdrawalWatches, discoveredVaultWithdrawals]);

  const watchedVaultDepositIds = vaultDepositWatches.filter(
    (movementId) => !settledVaultDepositIds.has(movementId)
  );
  const watchedVaultWithdrawalIds = vaultWithdrawalWatches.filter(
    (movementId) => !settledVaultWithdrawalIds.has(movementId)
  );

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

        {/* Errors pass undefined so a stale SWR success never renders as a
         * live figure: unavailable must read as unavailable, not as the last
         * total that happened to load. */}
        {/* The strategies read gates the skeleton too: it is the share-mint
         * vocabulary, it pages sequentially so it usually lands last, and
         * without it the summary can only report "unavailable". */}
        <TreasuryAllocationCard
          allocation={allocation}
          isLoading={
            !(walletsError || positionsError || strategiesError) &&
            (walletsLoading || positionsLoading || strategiesLoading)
          }
        />

        <TreasuryWalletsCard
          allocation={allocation}
          error={walletsError}
          isLoading={walletsLoading}
          shareMints={shareMints}
          wallets={activeWallets}
        />

        <ActiveVaultPositionsCard
          error={positionsError}
          isLoading={positionsLoading}
          onWithdraw={setWithdrawPosition}
          positions={positionsError ? undefined : positions}
          unrecordedShareMints={allocation.unrecordedShareMints}
          wallets={activeWallets}
        />

        <TreasuryStrategiesCard
          environment={sdpEnvironment}
          error={strategiesError}
          isLoading={strategiesLoading}
          onDeposit={setDepositStrategy}
          onRefresh={() => {
            refreshWallets();
            refreshStrategies();
            refreshPositions();
            refreshPrograms();
          }}
          positions={positionsError ? undefined : positions}
          providerAccess={providerAccess}
          strategies={strategies}
          unrecordedShareMints={allocation.unrecordedShareMints}
        />

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
          projectId={selectedProjectId}
          onDeposited={(deposit) => {
            // Two refreshes, for two different moments. This one shows the
            // claimed position row and the debited wallet right away; the
            // watch below is what re-reads them once the chain has actually
            // decided, which is the only point at which the holding is real.
            addVaultDepositWatches([deposit.movementId]);
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

      {withdrawPosition ? (
        <EarnVaultWithdrawModal
          environment={sdpEnvironment}
          onClose={() => setWithdrawPosition(null)}
          onWithdrawn={(withdrawal) => {
            addVaultWithdrawalWatches([withdrawal.movementId]);
            refreshPositions();
            refreshWallets();
          }}
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

      {watchedVaultWithdrawalIds.map((movementId) => (
        <EarnVaultWithdrawalOutcomeTracker
          key={`vault-withdrawal:${movementId}`}
          movementId={movementId}
          onSettled={() => {
            setSettledVaultWithdrawalIds((current) => new Set(current).add(movementId));
            // Only now did the exit change what the org holds: the shares are
            // burned and the proceeds sit in the custody wallet.
            refreshPositions();
            refreshWallets();
            setVaultWithdrawalWatches((current) =>
              current.filter((candidate) => candidate !== movementId)
            );
          }}
        />
      ))}

      {watchedVaultDepositIds.map((movementId) => (
        <EarnVaultDepositOutcomeTracker
          key={`vault-deposit:${movementId}`}
          movementId={movementId}
          onSettled={() => {
            setSettledVaultDepositIds((current) => new Set(current).add(movementId));
            // Only NOW is the position real: the shares exist on chain and the
            // wallet balance reflects what left it.
            refreshPositions();
            refreshWallets();
            setVaultDepositWatches((current) =>
              current.filter((candidate) => candidate !== movementId)
            );
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
