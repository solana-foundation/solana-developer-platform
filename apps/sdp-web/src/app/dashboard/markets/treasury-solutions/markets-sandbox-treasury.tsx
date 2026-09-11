"use client";

import { type EarnStrategy, WELL_KNOWN_TOKEN_BY_MINT, WELL_KNOWN_TOKENS } from "@sdp/types";
import {
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  DatabaseIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  WalletCardsIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { TokenMark } from "@/components/token-mark";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ListEmptyState } from "@/components/ui/list-empty-state";
import { Modal } from "@/components/ui/modal";
import { Select, SelectItem } from "@/components/ui/select";
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
import { earnProviderLabel } from "../earn/earn-format";
import {
  earnStrategyAsset,
  formatProviderAmount,
  formatProviderApy,
  sumDecimalStrings,
} from "../earn/earn-market-presentation";
import { useEarnStrategies } from "../earn/earn-program-data";
import {
  compareMarketsSandboxAmounts,
  MARKETS_SANDBOX_STABLE_SYMBOLS,
  MARKETS_SANDBOX_TOKEN_SYMBOLS,
  type MarketsSandboxPosition,
  type MarketsSandboxStableSymbol,
  normalizeMarketsSandboxAmount,
  useMarketsSandbox,
} from "../markets-sandbox-store";
import { estimatedTreasuryApy } from "./treasury-allocation";

function mainnetMint(symbol: (typeof MARKETS_SANDBOX_TOKEN_SYMBOLS)[number]): string {
  return WELL_KNOWN_TOKENS[symbol].mints["mainnet-beta"].address;
}

function strategyStableAsset(strategy: EarnStrategy): { mint: string; symbol: string } | null {
  for (const mint of strategy.depositMints) {
    const token = WELL_KNOWN_TOKEN_BY_MINT.get(mint);
    if (token?.isUsdStable) return { mint, symbol: token.symbol };
  }
  return null;
}

function SandboxMetric({
  label,
  value,
  caption,
}: {
  label: string;
  value: string;
  caption: string;
}) {
  return (
    <Card className="min-w-0 gap-0 rounded-2xl px-7 py-7">
      <dt className="text-sm leading-5 font-normal text-tertiary">{label}</dt>
      <dd className="mt-3 text-[28px] leading-8 font-medium tracking-[-0.2px] text-primary tabular-nums">
        {value}
      </dd>
      <dd className="mt-2 text-xs leading-5 text-tertiary">{caption}</dd>
    </Card>
  );
}

function SandboxDepositModal({
  strategy,
  balanceFor,
  onClose,
  onDeposit,
}: {
  strategy: EarnStrategy;
  balanceFor: (symbol: MarketsSandboxStableSymbol) => string;
  onClose: () => void;
  onDeposit: (payWith: MarketsSandboxStableSymbol, amount: string) => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const asset = strategyStableAsset(strategy);
  const preferredPayWith = MARKETS_SANDBOX_STABLE_SYMBOLS.find(
    (symbol) => symbol === asset?.symbol
  );
  const [payWith, setPayWith] = useState<MarketsSandboxStableSymbol>(preferredPayWith ?? "USDC");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const normalized = normalizeMarketsSandboxAmount(amount, payWith);
  const amountValid =
    normalized !== null && compareMarketsSandboxAmounts(normalized, "0", payWith) === 1;
  const enough =
    amountValid && compareMarketsSandboxAmounts(balanceFor(payWith), normalized, payWith) >= 0;
  const swapActive = asset !== null && payWith !== asset.symbol;

  return (
    <Modal
      ariaLabel={t("DashboardMarkets.sandbox.depositTitle", { strategy: strategy.name })}
      isOpen
      onClose={onClose}
    >
      <form
        className="p-6"
        onSubmit={(event) => {
          event.preventDefault();
          if (!asset || !normalized || !amountValid || !enough) return;
          try {
            onDeposit(payWith, normalized);
            toast.success(t("DashboardMarkets.sandbox.depositComplete"), {
              position: "bottom-right",
            });
            onClose();
          } catch (caught) {
            setError(
              caught instanceof Error ? caught.message : t("DashboardMarkets.sandbox.actionFailed")
            );
          }
        }}
      >
        <div className="pr-8">
          <h2 className="text-lg font-medium text-primary">
            {t("DashboardMarkets.sandbox.depositTitle", { strategy: strategy.name })}
          </h2>
          <p className="mt-1 text-sm leading-5 text-secondary">
            {t("DashboardMarkets.sandbox.depositDescription")}
          </p>
        </div>

        <div className="mt-6 grid gap-5">
          <div className="grid gap-2">
            <Label>{t("DashboardEarn.deposit.vaultPayWith")}</Label>
            <Select
              ariaLabel={t("DashboardEarn.deposit.vaultPayWith")}
              value={payWith}
              onValueChange={(value) => {
                if (value) setPayWith(value as MarketsSandboxStableSymbol);
              }}
            >
              {MARKETS_SANDBOX_STABLE_SYMBOLS.map((symbol) => (
                <SelectItem key={symbol} value={symbol}>
                  {symbol} · {formatProviderAmount(balanceFor(symbol), locale, symbol)}
                </SelectItem>
              ))}
            </Select>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="markets-sandbox-deposit-amount">
              {t("DashboardEarn.deposit.vaultAmount", { token: payWith })}
            </Label>
            <Input
              id="markets-sandbox-deposit-amount"
              inputMode="decimal"
              maxDecimals={6}
              onChange={(event) => setAmount(event.currentTarget.value)}
              placeholder="0.00"
              value={amount}
            />
            {!amountValid && amount.trim() ? (
              <p className="text-xs text-error">{t("DashboardMarkets.sandbox.invalidAmount")}</p>
            ) : amountValid && !enough ? (
              <p className="text-xs text-error">
                {t("DashboardMarkets.sandbox.insufficientBalance", { symbol: payWith })}
              </p>
            ) : null}
          </div>

          {asset ? (
            <div className="rounded-xl border border-border-default bg-fill-subtle px-4 py-3 text-sm">
              <div className="flex items-center justify-between gap-4">
                <span className="text-secondary">
                  {t("DashboardMarkets.sandbox.vaultReceives")}
                </span>
                <span className="text-primary tabular-nums">
                  {normalized ?? "0"} {asset.symbol}
                </span>
              </div>
              {swapActive ? (
                <>
                  <div className="mt-2 flex items-center justify-between gap-4">
                    <span className="text-secondary">
                      {t("DashboardEarn.deposit.vaultSwapRow")}
                    </span>
                    <span className="text-primary">
                      {payWith} → {asset.symbol}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-4">
                    <span className="text-secondary">{t("DashboardMarkets.sandbox.rate")}</span>
                    <span className="text-primary">
                      1 {payWith} = 1 {asset.symbol}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-4">
                    <span className="text-secondary">{t("DashboardMarkets.sandbox.slippage")}</span>
                    <span className="text-success">0%</span>
                  </div>
                </>
              ) : null}
            </div>
          ) : (
            <p className="rounded-xl border border-destructive-border bg-destructive-bg px-4 py-3 text-sm text-error">
              {t("DashboardMarkets.sandbox.assetUnavailable")}
            </p>
          )}

          {error ? (
            <p className="rounded-xl border border-destructive-border bg-destructive-bg px-4 py-3 text-sm text-error">
              {error}
            </p>
          ) : null}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("DashboardEarn.deposit.cancel")}
          </Button>
          <Button disabled={!asset || !amountValid || !enough} type="submit">
            {t("DashboardEarn.deposit.vaultSubmit")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function SandboxWithdrawModal({
  position,
  onClose,
  onWithdraw,
}: {
  position: MarketsSandboxPosition;
  onClose: () => void;
  onWithdraw: (amount: string, receiveAs: MarketsSandboxStableSymbol) => void;
}) {
  const t = useTranslations();
  const [amount, setAmount] = useState(position.amount);
  const [receiveAs, setReceiveAs] = useState<MarketsSandboxStableSymbol>(
    MARKETS_SANDBOX_STABLE_SYMBOLS.includes(position.assetSymbol as MarketsSandboxStableSymbol)
      ? (position.assetSymbol as MarketsSandboxStableSymbol)
      : "USDC"
  );
  const [error, setError] = useState<string | null>(null);
  const normalized = normalizeMarketsSandboxAmount(amount, receiveAs);
  const amountValid =
    normalized !== null &&
    compareMarketsSandboxAmounts(normalized, "0", receiveAs) === 1 &&
    compareMarketsSandboxAmounts(position.amount, normalized, receiveAs) >= 0;

  return (
    <Modal
      ariaLabel={t("DashboardMarkets.sandbox.withdrawTitle", { strategy: position.strategyName })}
      isOpen
      onClose={onClose}
    >
      <form
        className="p-6"
        onSubmit={(event) => {
          event.preventDefault();
          if (!normalized || !amountValid) return;
          try {
            onWithdraw(normalized, receiveAs);
            toast.success(t("DashboardMarkets.sandbox.withdrawComplete"), {
              position: "bottom-right",
            });
            onClose();
          } catch (caught) {
            setError(
              caught instanceof Error ? caught.message : t("DashboardMarkets.sandbox.actionFailed")
            );
          }
        }}
      >
        <div className="pr-8">
          <h2 className="text-lg font-medium text-primary">
            {t("DashboardMarkets.sandbox.withdrawTitle", { strategy: position.strategyName })}
          </h2>
          <p className="mt-1 text-sm leading-5 text-secondary">
            {t("DashboardMarkets.sandbox.withdrawDescription")}
          </p>
        </div>

        <div className="mt-6 grid gap-5">
          <div className="grid gap-2">
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="markets-sandbox-withdraw-amount">
                {t("DashboardEarn.vaultWithdraw.sharesLabel")}
              </Label>
              <button
                className="text-xs font-medium text-secondary hover:text-primary"
                onClick={() => setAmount(position.amount)}
                type="button"
              >
                {t("DashboardEarn.vaultWithdraw.max")}
              </button>
            </div>
            <Input
              id="markets-sandbox-withdraw-amount"
              inputMode="decimal"
              maxDecimals={6}
              onChange={(event) => setAmount(event.currentTarget.value)}
              value={amount}
            />
            <p className="text-xs text-tertiary">
              {position.amount} {position.assetSymbol} {t("DashboardMarkets.sandbox.available")}
            </p>
          </div>

          <div className="grid gap-2">
            <Label>{t("DashboardEarn.vaultWithdraw.receiveAs")}</Label>
            <Select
              ariaLabel={t("DashboardEarn.vaultWithdraw.receiveAs")}
              value={receiveAs}
              onValueChange={(value) => {
                if (value) setReceiveAs(value as MarketsSandboxStableSymbol);
              }}
            >
              {MARKETS_SANDBOX_STABLE_SYMBOLS.map((symbol) => (
                <SelectItem key={symbol} value={symbol}>
                  {symbol}
                </SelectItem>
              ))}
            </Select>
          </div>

          {receiveAs !== position.assetSymbol ? (
            <div className="rounded-xl border border-border-default bg-fill-subtle px-4 py-3 text-sm">
              <div className="flex items-center justify-between gap-4">
                <span className="text-secondary">{t("DashboardMarkets.sandbox.rate")}</span>
                <span className="text-primary">
                  1 {position.assetSymbol} = 1 {receiveAs}
                </span>
              </div>
              <div className="mt-2 flex items-center justify-between gap-4">
                <span className="text-secondary">{t("DashboardMarkets.sandbox.slippage")}</span>
                <span className="text-success">0%</span>
              </div>
            </div>
          ) : null}

          {!amountValid && amount.trim() ? (
            <p className="text-sm text-error">{t("DashboardMarkets.sandbox.invalidWithdrawal")}</p>
          ) : null}
          {error ? <p className="text-sm text-error">{error}</p> : null}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("DashboardEarn.deposit.cancel")}
          </Button>
          <Button disabled={!amountValid} type="submit">
            {t("DashboardEarn.vaultWithdraw.submit")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function MarketsSandboxTreasury() {
  const t = useTranslations();
  const locale = useLocale();
  const { selectedProjectId } = useDashboardWorkspace();
  const { state, deposit, fund, reset, withdraw } = useMarketsSandbox(selectedProjectId);
  const { strategies, error, isLoading, refresh } = useEarnStrategies({ cluster: "mainnet-beta" });
  const [depositStrategy, setDepositStrategy] = useState<EarnStrategy | null>(null);
  const [withdrawPosition, setWithdrawPosition] = useState<MarketsSandboxPosition | null>(null);

  const availableCash =
    sumDecimalStrings(MARKETS_SANDBOX_STABLE_SYMBOLS.map((symbol) => state.balances[symbol])) ??
    "0";
  const deployedValue =
    sumDecimalStrings(state.positions.map((position) => position.amount)) ?? "0";
  const portfolioApy = useMemo(
    () =>
      estimatedTreasuryApy({
        positions: state.positions.map((position) => ({
          closedAt: null,
          custodyWalletId: "markets-sandbox-wallet",
          provider: position.provider,
          providerReference: position.providerReference,
          shareMint: position.shareMint ?? `sandbox-share:${position.strategyId}`,
          shares: position.shares,
          tokenMint: position.assetMint,
          tokenValue: position.amount,
        })),
        strategies,
      }),
    [state.positions, strategies]
  );
  const positionByStrategy = new Map(
    state.positions.map((position) => [position.strategyId, position] as const)
  );

  return (
    <DashboardWorkspaceOverviewPanel>
      <div className="mx-auto flex w-full max-w-[90rem] flex-col gap-12">
        <div className="flex items-start gap-3 rounded-xl border border-info-border bg-info-bg px-4 py-3 text-sm text-info">
          <DatabaseIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-medium">{t("DashboardMarkets.sandbox.bannerTitle")}</p>
            <p className="mt-1 leading-5">{t("DashboardMarkets.sandbox.bannerDescription")}</p>
          </div>
        </div>

        <dl className="grid gap-2 md:grid-cols-3">
          <SandboxMetric
            caption={t("DashboardMarkets.sandbox.cashCaption")}
            label={t("DashboardMarkets.treasury.summaryCash")}
            value={formatProviderAmount(availableCash, locale)}
          />
          <SandboxMetric
            caption={t("DashboardMarkets.sandbox.deployedCaption")}
            label={t("DashboardMarkets.treasury.summaryDeposited")}
            value={formatProviderAmount(deployedValue, locale)}
          />
          <SandboxMetric
            caption={t("DashboardMarkets.sandbox.apyCaption")}
            label={t("DashboardMarkets.treasury.summaryApy")}
            value={formatProviderApy(portfolioApy, locale)}
          />
        </dl>

        <section>
          <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="text-[19px] leading-6 font-medium text-primary">
                {t("DashboardMarkets.sandbox.walletTitle")}
              </h2>
              <p className="mt-1 text-sm text-secondary">
                {t("DashboardMarkets.sandbox.walletDescription")}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                iconLeft={<RotateCcwIcon />}
                onClick={() => {
                  reset();
                  toast.success(t("DashboardMarkets.sandbox.resetComplete"), {
                    position: "bottom-right",
                  });
                }}
                size="sm"
                type="button"
                variant="ghost"
              >
                {t("DashboardMarkets.sandbox.reset")}
              </Button>
              <Button
                iconLeft={<WalletCardsIcon />}
                onClick={() => {
                  fund();
                  toast.success(t("DashboardMarkets.sandbox.fundComplete"), {
                    position: "bottom-right",
                  });
                }}
                size="sm"
                type="button"
              >
                {t("DashboardMarkets.sandbox.fund")}
              </Button>
            </div>
          </div>
          <Card className="gap-0 overflow-hidden rounded-2xl py-0">
            <div className="grid grid-cols-2 gap-px bg-border-subtle sm:grid-cols-3 lg:grid-cols-5">
              {MARKETS_SANDBOX_TOKEN_SYMBOLS.map((symbol) => (
                <div className="flex items-center gap-3 bg-surface-raised px-5 py-5" key={symbol}>
                  <TokenMark mint={mainnetMint(symbol)} size="md" symbol={symbol} />
                  <div className="min-w-0">
                    <p className="text-xs text-tertiary">{symbol}</p>
                    <p className="mt-1 truncate text-sm text-primary tabular-nums">
                      {formatProviderAmount(state.balances[symbol], locale, symbol)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </section>

        <section>
          <h2 className="mb-4 text-[19px] leading-6 font-medium text-primary">
            {t("DashboardMarkets.treasury.vaultPositionsTitle")}
          </h2>
          <Card className="overflow-hidden rounded-2xl py-0">
            {state.positions.length === 0 ? (
              <ListEmptyState
                description={t("DashboardMarkets.sandbox.positionsEmptyDescription")}
                icon={<WalletCardsIcon aria-hidden="true" className="size-5" />}
                message={t("DashboardMarkets.treasury.vaultPositionsEmptyTitle")}
              />
            ) : (
              <div className="overflow-x-auto">
                <Table className="!rounded-none !border-0" style={{ minWidth: "48rem" }}>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("DashboardMarkets.treasury.position")}</TableHead>
                      <TableHead>{t("DashboardMarkets.treasury.asset")}</TableHead>
                      <TableHead>{t("DashboardMarkets.treasury.balance")}</TableHead>
                      <TableHead>{t("DashboardMarkets.treasury.status")}</TableHead>
                      <TableHead align="right">{t("DashboardMarkets.treasury.actions")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {state.positions.map((position) => (
                      <TableRow key={position.id}>
                        <TableCell>
                          <p className="text-sm text-primary">{position.strategyName}</p>
                          <p className="mt-0.5 text-xs text-tertiary">
                            {earnProviderLabel(position.provider)}
                          </p>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2 text-sm text-secondary">
                            <TokenMark
                              mint={position.assetMint}
                              size="sm"
                              symbol={position.assetSymbol}
                            />
                            {position.assetSymbol}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm text-primary tabular-nums">
                          {formatProviderAmount(position.amount, locale, position.assetSymbol)}
                        </TableCell>
                        <TableCell>
                          <Badge variant="success">{t("DashboardMarkets.sandbox.complete")}</Badge>
                        </TableCell>
                        <TableCell align="right">
                          <Button
                            iconLeft={<ArrowUpRightIcon />}
                            onClick={() => setWithdrawPosition(position)}
                            size="sm"
                            type="button"
                            variant="secondary"
                          >
                            {t("DashboardMarkets.treasury.withdraw")}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Card>
        </section>

        <section>
          <div className="mb-4 flex items-center justify-between gap-4">
            <div>
              <h2 className="text-[19px] leading-6 font-medium text-primary">
                {t("DashboardMarkets.treasury.strategiesTitle")}
              </h2>
              <p className="mt-1 text-sm text-secondary">
                {t("DashboardMarkets.sandbox.strategiesDescription")}
              </p>
            </div>
            <Button
              iconLeft={<RefreshCwIcon />}
              onClick={() => refresh()}
              size="sm"
              type="button"
              variant="ghost"
            >
              {t("DashboardMarkets.treasury.refresh")}
            </Button>
          </div>
          <Card className="overflow-hidden rounded-2xl py-0">
            {isLoading && strategies === undefined ? (
              <div className="grid gap-3 px-6 py-5">
                <SkeletonBlock className="h-14 rounded-xl" />
                <SkeletonBlock className="h-14 rounded-xl" />
                <SkeletonBlock className="h-14 rounded-xl" />
              </div>
            ) : error ? (
              <ListEmptyState
                description={t("DashboardMarkets.treasury.strategiesErrorDescription")}
                icon={<DatabaseIcon aria-hidden="true" className="size-5" />}
                message={t("DashboardMarkets.treasury.strategiesErrorTitle")}
              />
            ) : (
              <div className="overflow-x-auto">
                <Table className="!rounded-none !border-0" style={{ minWidth: "56rem" }}>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("DashboardMarkets.treasury.strategy")}</TableHead>
                      <TableHead>{t("DashboardMarkets.treasury.asset")}</TableHead>
                      <TableHead>{t("DashboardMarkets.treasury.yourPosition")}</TableHead>
                      <TableHead>{t("DashboardMarkets.treasury.apy")}</TableHead>
                      <TableHead>{t("DashboardMarkets.treasury.status")}</TableHead>
                      <TableHead align="right">{t("DashboardMarkets.treasury.actions")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(strategies ?? []).map((strategy) => {
                      const asset = earnStrategyAsset(strategy);
                      const position = positionByStrategy.get(strategy.id);
                      return (
                        <TableRow key={strategy.id}>
                          <TableCell>
                            <p className="max-w-72 text-sm text-primary">{strategy.name}</p>
                            <p className="mt-0.5 text-xs text-tertiary">
                              {earnProviderLabel(strategy.provider)}
                            </p>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2 text-sm text-secondary">
                              {asset ? (
                                <TokenMark mint={asset.mint} size="sm" symbol={asset.symbol} />
                              ) : null}
                              {asset?.symbol ?? "—"}
                            </div>
                          </TableCell>
                          <TableCell className="text-sm text-primary tabular-nums">
                            {position
                              ? formatProviderAmount(position.amount, locale, position.assetSymbol)
                              : "—"}
                          </TableCell>
                          <TableCell className="text-sm text-primary tabular-nums">
                            {formatProviderApy(strategy.currentApy, locale)}
                          </TableCell>
                          <TableCell>
                            <Badge variant="success">
                              {t("DashboardMarkets.sandbox.available")}
                            </Badge>
                          </TableCell>
                          <TableCell align="right">
                            <Button
                              disabled={strategyStableAsset(strategy) === null}
                              iconLeft={<ArrowDownLeftIcon />}
                              onClick={() => setDepositStrategy(strategy)}
                              size="sm"
                              type="button"
                            >
                              {t("DashboardMarkets.treasury.deposit")}
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </Card>
        </section>
      </div>

      {depositStrategy ? (
        <SandboxDepositModal
          key={depositStrategy.id}
          balanceFor={(symbol) => state.balances[symbol]}
          onClose={() => setDepositStrategy(null)}
          onDeposit={(payWith, amount) => {
            const asset = strategyStableAsset(depositStrategy);
            if (!asset) throw new Error(t("DashboardMarkets.sandbox.assetUnavailable"));
            deposit({
              strategyId: depositStrategy.id,
              provider: depositStrategy.provider,
              providerReference: depositStrategy.providerReference,
              strategyName: depositStrategy.name,
              assetSymbol: asset.symbol,
              assetMint: asset.mint,
              ...(depositStrategy.shareMint ? { shareMint: depositStrategy.shareMint } : {}),
              payWith,
              amount,
            });
          }}
          strategy={depositStrategy}
        />
      ) : null}

      {withdrawPosition ? (
        <SandboxWithdrawModal
          key={withdrawPosition.id}
          onClose={() => setWithdrawPosition(null)}
          onWithdraw={(amount, receiveAs) => withdraw(withdrawPosition.id, amount, receiveAs)}
          position={withdrawPosition}
        />
      ) : null}
    </DashboardWorkspaceOverviewPanel>
  );
}
