"use client";

import { WELL_KNOWN_TOKENS } from "@sdp/types";
import { ArrowDownToLineIcon, ArrowUpFromLineIcon, InfoIcon, WalletCardsIcon } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import { toast } from "sonner";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { TokenMark } from "@/components/token-mark";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import {
  applyStrategyTransaction,
  INITIAL_TREASURY_STATE,
  parseUsdcMicros,
  type StrategyTransactionError,
  type StrategyTransactionMode,
  type TreasuryStrategy,
  USDC_MICROS,
} from "./treasury-solutions-model";

const WALLET_BALANCES = [
  { symbol: "SOL", amount: 1_000 },
  { symbol: "USDT", amount: 0 },
  { symbol: "USDG", amount: 0 },
] as const;

const ERROR_MESSAGE_KEYS: Record<StrategyTransactionError, MessageKey> = {
  invalid_amount: "DashboardMarkets.treasury.invalidAmount",
  insufficient_wallet_balance: "DashboardMarkets.treasury.insufficientWalletBalance",
  insufficient_strategy_balance: "DashboardMarkets.treasury.insufficientStrategyBalance",
  strategy_not_found: "DashboardMarkets.treasury.invalidAmount",
};

const MINT_BY_SYMBOL = {
  SOL: WELL_KNOWN_TOKENS.SOL.mints["mainnet-beta"].address,
  USDC: WELL_KNOWN_TOKENS.USDC.mints["mainnet-beta"].address,
  USDT: WELL_KNOWN_TOKENS.USDT.mints["mainnet-beta"].address,
  USDG: WELL_KNOWN_TOKENS.USDG.mints["mainnet-beta"].address,
  PYUSD: WELL_KNOWN_TOKENS.PYUSD.mints["mainnet-beta"].address,
} satisfies Record<"SOL" | "USDC" | "USDT" | "USDG" | "PYUSD", string>;

interface OpenTransaction {
  strategyId: string;
  mode: StrategyTransactionMode;
}

function useTreasuryFormatters() {
  const locale = useLocale();
  return useMemo(() => {
    const token = new Intl.NumberFormat(locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const usd = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const apy = new Intl.NumberFormat(locale, {
      style: "percent",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return {
      token: (amount: number) => token.format(amount),
      usdMicros: (amountMicros: number) => usd.format(amountMicros / USDC_MICROS),
      apy: (percent: number) => apy.format(percent / 100),
    };
  }, [locale]);
}

function WalletBalance({
  amount,
  symbol,
}: {
  amount: number;
  symbol: keyof typeof MINT_BY_SYMBOL;
}) {
  const format = useTreasuryFormatters();
  return (
    <div className="flex min-w-0 items-center gap-3 px-5 py-5">
      <TokenMark mint={MINT_BY_SYMBOL[symbol]} symbol={symbol} size="md" />
      <div className="min-w-0">
        <dt className="text-xs text-tertiary">{symbol}</dt>
        <dd className="mt-1 truncate text-xl font-medium tracking-tight text-primary tabular-nums">
          {format.token(amount)}
        </dd>
      </div>
    </div>
  );
}

function StrategyIdentity({ strategy }: { strategy: TreasuryStrategy }) {
  const t = useTranslations();
  return (
    <div className="flex min-w-0 items-center gap-3">
      <TokenMark mint={MINT_BY_SYMBOL[strategy.asset]} symbol={strategy.asset} size="md" />
      <div className="min-w-0">
        <p className="truncate text-sm text-primary">{strategy.name}</p>
        <p className="mt-0.5 text-xs text-tertiary">
          {strategy.asset} · {t("DashboardMarkets.treasury.variableRate")}
        </p>
      </div>
    </div>
  );
}

function StrategyActions({
  strategy,
  onOpen,
}: {
  strategy: TreasuryStrategy;
  onOpen: (transaction: OpenTransaction) => void;
}) {
  const t = useTranslations();
  return (
    <div className="flex justify-end gap-2">
      <Button
        iconLeft={<ArrowDownToLineIcon />}
        onClick={() => onOpen({ strategyId: strategy.id, mode: "deposit" })}
        size="sm"
        type="button"
      >
        {t("DashboardMarkets.treasury.deposit")}
      </Button>
      <Button
        disabled={strategy.balanceMicros === 0}
        iconLeft={<ArrowUpFromLineIcon />}
        onClick={() => onOpen({ strategyId: strategy.id, mode: "withdraw" })}
        size="sm"
        type="button"
        variant="secondary"
      >
        {t("DashboardMarkets.treasury.withdraw")}
      </Button>
    </div>
  );
}

function StrategyTransactionModal({
  availableMicros,
  onClose,
  onSubmit,
  strategy,
  transaction,
}: {
  availableMicros: number;
  onClose: () => void;
  onSubmit: (amount: string) => StrategyTransactionError | null;
  strategy: TreasuryStrategy | null;
  transaction: OpenTransaction | null;
}) {
  const t = useTranslations();
  const format = useTreasuryFormatters();
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<StrategyTransactionError | null>(null);

  if (!strategy || !transaction) return null;

  const isDeposit = transaction.mode === "deposit";
  const limitMicros = isDeposit ? availableMicros : strategy.balanceMicros;
  const title = t(
    isDeposit
      ? "DashboardMarkets.treasury.transactionDepositTitle"
      : "DashboardMarkets.treasury.transactionWithdrawTitle",
    { strategy: strategy.name }
  );
  const description = t(
    isDeposit
      ? "DashboardMarkets.treasury.transactionDescriptionDeposit"
      : "DashboardMarkets.treasury.transactionDescriptionWithdraw"
  );

  const close = () => {
    setAmount("");
    setError(null);
    onClose();
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const submitError = onSubmit(amount);
    if (submitError) {
      setError(submitError);
      return;
    }
    setAmount("");
    setError(null);
  };

  return (
    <Modal ariaLabel={title} isOpen onClose={close} size="sm">
      <form onSubmit={submit}>
        <div className="border-b border-border-default px-6 py-5 pr-14">
          <div className="flex items-center gap-3">
            <TokenMark mint={MINT_BY_SYMBOL[strategy.asset]} symbol={strategy.asset} size="md" />
            <div className="min-w-0">
              <h2 className="truncate text-lg font-medium tracking-tight text-primary">{title}</h2>
              <p className="mt-1 text-sm leading-5 text-secondary">{description}</p>
            </div>
          </div>
        </div>

        <div className="space-y-5 px-6 py-5">
          <div className="flex items-center justify-between gap-4 rounded-xl bg-fill-subtle px-4 py-3">
            <div>
              <p className="text-xs text-tertiary">{t("DashboardMarkets.treasury.available")}</p>
              <p className="mt-1 text-sm font-medium text-primary tabular-nums">
                {format.usdMicros(limitMicros)} {t("DashboardMarkets.treasury.amountSuffix")}
              </p>
            </div>
            <Button
              onClick={() => {
                setAmount(String(limitMicros / USDC_MICROS));
                setError(null);
              }}
              size="xs"
              type="button"
              variant="secondary"
            >
              {t("DashboardMarkets.treasury.max")}
            </Button>
          </div>

          <div>
            <Label htmlFor="treasury-transaction-amount">
              {t("DashboardMarkets.treasury.amount")}
              <span className="font-normal text-secondary">
                {t("DashboardMarkets.treasury.amountSuffix")}
              </span>
            </Label>
            <Input
              aria-describedby={error ? "treasury-transaction-error" : undefined}
              aria-invalid={Boolean(error)}
              autoFocus
              className="mt-2"
              id="treasury-transaction-amount"
              inputMode="decimal"
              maxDecimals={6}
              onChange={(event) => {
                setAmount(event.currentTarget.value);
                setError(null);
              }}
              placeholder={t("DashboardMarkets.treasury.amountPlaceholder")}
              value={amount}
            />
            {error ? (
              <p className="mt-2 text-sm text-error" id="treasury-transaction-error" role="alert">
                {t(ERROR_MESSAGE_KEYS[error])}
              </p>
            ) : null}
          </div>

          {isDeposit && strategy.asset === "PYUSD" ? (
            <Callout title={t("DashboardMarkets.treasury.pyusdSwapTitle")} variant="info">
              <span className="flex items-start gap-2">
                <InfoIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                <span>{t("DashboardMarkets.treasury.pyusdSwapDescription")}</span>
              </span>
            </Callout>
          ) : null}
        </div>

        <div className="flex justify-end gap-2 border-t border-border-default px-6 py-4">
          <Button onClick={close} type="button" variant="secondary">
            {t("DashboardMarkets.treasury.cancel")}
          </Button>
          <Button type="submit">
            {t(
              isDeposit
                ? "DashboardMarkets.treasury.confirmDeposit"
                : "DashboardMarkets.treasury.confirmWithdraw"
            )}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function TreasurySolutionsWorkspace() {
  const t = useTranslations();
  const format = useTreasuryFormatters();
  const [state, setState] = useState(() => ({
    ...INITIAL_TREASURY_STATE,
    strategies: INITIAL_TREASURY_STATE.strategies.map((strategy) => ({
      ...strategy,
    })),
  }));
  const [transaction, setTransaction] = useState<OpenTransaction | null>(null);
  const activeStrategy = transaction
    ? (state.strategies.find((strategy) => strategy.id === transaction.strategyId) ?? null)
    : null;

  const submitTransaction = (amount: string): StrategyTransactionError | null => {
    if (!transaction || !activeStrategy) return "strategy_not_found";
    const amountMicros = parseUsdcMicros(amount);
    const result = applyStrategyTransaction(state, {
      ...transaction,
      amountMicros,
    });
    if (!result.ok) return result.error;

    setState(result.state);
    const formattedAmount = format.token((amountMicros ?? 0) / USDC_MICROS);
    toast.success(
      t(
        transaction.mode === "deposit"
          ? "DashboardMarkets.treasury.depositSuccess"
          : "DashboardMarkets.treasury.withdrawSuccess",
        { amount: formattedAmount, strategy: activeStrategy.name }
      )
    );
    setTransaction(null);
    return null;
  };

  return (
    <DashboardWorkspaceOverviewPanel>
      <div className="mx-auto w-full max-w-7xl space-y-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-2xl">
            <p className="text-xs font-medium uppercase tracking-wide text-tertiary">
              {t("DashboardMarkets.treasury.eyebrow")}
            </p>
            <p className="mt-2 text-sm leading-6 text-secondary">
              {t("DashboardMarkets.treasury.description")}
            </p>
          </div>
          <Badge variant="outline">{t("DashboardMarkets.treasury.mockData")}</Badge>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <WalletCardsIcon aria-hidden="true" className="size-5 text-secondary" />
              {t("DashboardMarkets.treasury.connectedWallet")}
            </CardTitle>
            <CardDescription>{t("DashboardMarkets.treasury.walletDescription")}</CardDescription>
            <CardAction>
              <span className="rounded-lg bg-fill-subtle px-3 py-2 text-sm text-secondary">
                {t("DashboardMarkets.treasury.walletAddress")}
              </span>
            </CardAction>
          </CardHeader>
          <CardContent>
            <dl className="grid overflow-hidden rounded-xl border border-border-default sm:grid-cols-2 xl:grid-cols-4 [&>*:not(:last-child)]:border-b [&>*:not(:last-child)]:border-border-subtle sm:[&>*:nth-child(odd)]:border-r sm:[&>*:nth-child(3)]:border-b-0 xl:[&>*:not(:last-child)]:border-r xl:[&>*:not(:last-child)]:border-b-0">
              <WalletBalance amount={WALLET_BALANCES[0].amount} symbol="SOL" />
              <WalletBalance amount={state.walletUsdcMicros / USDC_MICROS} symbol="USDC" />
              <WalletBalance amount={WALLET_BALANCES[1].amount} symbol="USDT" />
              <WalletBalance amount={WALLET_BALANCES[2].amount} symbol="USDG" />
            </dl>
          </CardContent>
        </Card>

        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle>{t("DashboardMarkets.treasury.strategiesTitle")}</CardTitle>
            <CardDescription>
              {t("DashboardMarkets.treasury.strategiesDescription")}
            </CardDescription>
            <CardAction>
              <div className="rounded-xl bg-fill-subtle px-4 py-3 text-right">
                <p className="text-xs text-tertiary">
                  {t("DashboardMarkets.treasury.availableToInvest")}
                </p>
                <p className="mt-1 text-lg font-medium tracking-tight text-primary tabular-nums">
                  {format.usdMicros(state.walletUsdcMicros)}
                </p>
                <p className="mt-0.5 text-xs text-secondary">
                  {t("DashboardMarkets.treasury.availableToInvestDescription")}
                </p>
              </div>
            </CardAction>
          </CardHeader>
          <CardContent className="px-0">
            <div className="overflow-x-auto border-y border-border-subtle">
              <Table className="table-fixed" style={{ minWidth: "58rem" }}>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[31%]">
                      {t("DashboardMarkets.treasury.strategy")}
                    </TableHead>
                    <TableHead className="w-[13%]">
                      {t("DashboardMarkets.treasury.asset")}
                    </TableHead>
                    <TableHead className="w-[14%]">{t("DashboardMarkets.treasury.apy")}</TableHead>
                    <TableHead className="w-[18%]">
                      {t("DashboardMarkets.treasury.balance")}
                    </TableHead>
                    <TableHead align="right" className="w-[24%]">
                      <span className="sr-only">{t("DashboardMarkets.treasury.actions")}</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {state.strategies.map((strategy) => (
                    <TableRow key={strategy.id}>
                      <TableCell>
                        <StrategyIdentity strategy={strategy} />
                      </TableCell>
                      <TableCell className="text-sm text-secondary">{strategy.asset}</TableCell>
                      <TableCell>
                        <p className="text-xl font-medium tracking-tight text-primary tabular-nums">
                          {format.apy(strategy.apyPercent)}
                        </p>
                      </TableCell>
                      <TableCell>
                        {strategy.balanceMicros > 0 ? (
                          <div>
                            <p className="text-sm text-primary tabular-nums">
                              {format.usdMicros(strategy.balanceMicros)}
                            </p>
                            <p className="mt-0.5 text-xs text-tertiary">
                              {t("DashboardMarkets.treasury.positionValue")}
                            </p>
                          </div>
                        ) : (
                          <span className="text-sm text-tertiary">
                            {t("DashboardMarkets.treasury.noBalance")}
                          </span>
                        )}
                      </TableCell>
                      <TableCell align="right">
                        <StrategyActions onOpen={setTransaction} strategy={strategy} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="flex items-start gap-2 px-6 py-4 text-xs leading-5 text-tertiary">
              <InfoIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <p>{t("DashboardMarkets.treasury.indicativeRateDisclosure")}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <StrategyTransactionModal
        availableMicros={state.walletUsdcMicros}
        onClose={() => setTransaction(null)}
        onSubmit={submitTransaction}
        strategy={activeStrategy}
        transaction={transaction}
      />
    </DashboardWorkspaceOverviewPanel>
  );
}
