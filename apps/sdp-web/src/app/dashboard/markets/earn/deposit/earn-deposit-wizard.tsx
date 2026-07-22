"use client";

import { earnCuratorLabel } from "@sdp/types";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BanknoteIcon,
  CheckIcon,
  KeyRoundIcon,
  Loader2Icon,
  ScaleIcon,
  ShieldIcon,
  TrendingUpIcon,
  WalletIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ChangeEvent, type ReactNode, useMemo, useState } from "react";
import { PaymentsWizardFrame } from "@/app/dashboard/payments/payments-wizard-frame";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectItem } from "@/components/ui/select";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { useDashboardRouter } from "@/lib/use-dashboard-router";
import { cn } from "@/lib/utils";
import {
  commonDepositMints,
  DEFAULT_DEPOSIT_MINT,
  EARN_RISK_TIERS,
  type EarnRiskTier,
  formatApy,
  formatTokenAmount,
  formatUsd,
  formatUsdCompact,
  getMockStrategy,
  MOCK_EARN_STRATEGIES,
  MOCK_EARN_WALLETS,
  type MockEarnStrategy,
  projectYearlyYield,
  tokenSymbol,
} from "../earn-mock-data";
import { addMockPosition } from "../earn-mock-positions";

const STEP_IDS = ["profile", "strategy", "amount", "review"] as const;
type StepId = (typeof STEP_IDS)[number];

type AllocationMode = "single" | "split";
type WalletSource = "sdp" | "byok";

/** strategyId → allocation percent (split mode). Presence = selected. */
type SplitAllocation = Record<string, number>;

interface DepositLeg {
  strategy: MockEarnStrategy;
  pct: number;
  legAmount: number;
}

const stepMeta: Record<StepId, { label: MessageKey; title: MessageKey; description: MessageKey }> =
  {
    profile: {
      label: "DashboardEarn.wizard.profileLabel",
      title: "DashboardEarn.wizard.profileTitle",
      description: "DashboardEarn.wizard.profileDescription",
    },
    strategy: {
      label: "DashboardEarn.wizard.strategyLabel",
      title: "DashboardEarn.wizard.strategyTitle",
      description: "DashboardEarn.wizard.strategyDescription",
    },
    amount: {
      label: "DashboardEarn.wizard.amountLabel",
      title: "DashboardEarn.wizard.amountTitle",
      description: "DashboardEarn.wizard.amountDescription",
    },
    review: {
      label: "DashboardEarn.wizard.reviewLabel",
      title: "DashboardEarn.wizard.reviewTitle",
      description: "DashboardEarn.wizard.reviewDescription",
    },
  };

const RISK_ICONS: Record<EarnRiskTier, typeof ShieldIcon> = {
  conservative: ShieldIcon,
  balanced: ScaleIcon,
  enhanced: TrendingUpIcon,
};

const stepVariants = {
  initial: (direction: number) => ({ x: direction * 32, opacity: 0 }),
  animate: { x: 0, opacity: 1 },
  exit: (direction: number) => ({ x: direction * -32, opacity: 0 }),
};

// Loose base58 shape check — enough to demo BYOK validation without a full decode.
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function isLikelySolanaAddress(value: string): boolean {
  return SOLANA_ADDRESS_RE.test(value.trim());
}

function selectedSplitStrategies(split: SplitAllocation): MockEarnStrategy[] {
  return Object.keys(split)
    .map((id) => getMockStrategy(id))
    .filter((s): s is MockEarnStrategy => Boolean(s));
}

function evenSplit(ids: string[]): SplitAllocation {
  const next: SplitAllocation = {};
  if (ids.length === 0) return next;
  const base = Math.floor(100 / ids.length);
  const remainder = 100 - base * ids.length;
  ids.forEach((id, index) => {
    next[id] = base + (index === 0 ? remainder : 0);
  });
  return next;
}

function splitTotal(split: SplitAllocation): number {
  return Object.values(split).reduce((sum, pct) => sum + pct, 0);
}

function buildLegs(split: SplitAllocation, totalAmount: number): DepositLeg[] {
  return selectedSplitStrategies(split).map((strategy) => ({
    strategy,
    pct: split[strategy.id] ?? 0,
    legAmount: totalAmount * ((split[strategy.id] ?? 0) / 100),
  }));
}

function useLiquidityLabel() {
  const t = useTranslations();
  return (strategy: MockEarnStrategy): string => {
    if (strategy.liquidityTerm === "instant") {
      return t("DashboardEarn.liquidity.instant");
    }
    const days = strategy.redemptionDelayDays ?? 1;
    if (strategy.intradayFraction) {
      return t("DashboardEarn.liquidity.mixed", {
        pct: Math.round(strategy.intradayFraction * 100),
        days,
      });
    }
    return t("DashboardEarn.liquidity.delayed", { days });
  };
}

function RadioDot({ selected, square = false }: { selected: boolean; square?: boolean }) {
  return (
    <span
      className={cn(
        "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border-2",
        square ? "rounded-[5px]" : "rounded-full",
        selected ? "border-primary bg-primary text-on-primary" : "border-border-strong"
      )}
      aria-hidden
    >
      {selected ? (
        square ? (
          <CheckIcon className="h-3 w-3" />
        ) : (
          <span className="h-2 w-2 rounded-full bg-primary" />
        )
      ) : null}
    </span>
  );
}

function ChipButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        active
          ? "border-primary bg-primary text-on-primary"
          : "border-border-default bg-surface-raised text-secondary hover:text-primary"
      )}
    >
      {children}
    </button>
  );
}

/** Segmented two-option toggle (allocation mode, wallet source). */
function SegmentedToggle<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; icon?: typeof WalletIcon }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-border-default bg-surface-raised p-0.5">
      {options.map((option) => {
        const Icon = option.icon;
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            aria-pressed={active}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
              active ? "bg-fill text-primary" : "text-secondary hover:text-primary"
            )}
          >
            {Icon ? <Icon className="h-3.5 w-3.5" /> : null}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border-default py-2 text-sm last:border-b-0">
      <span className="shrink-0 text-xs text-secondary">{label}</span>
      <span className="min-w-0 truncate text-right text-primary">{value}</span>
    </div>
  );
}

function ProfileStep({
  riskTier,
  onSelect,
}: {
  riskTier: EarnRiskTier | null;
  onSelect: (tier: EarnRiskTier) => void;
}) {
  const t = useTranslations();

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {EARN_RISK_TIERS.map((tier) => {
        const Icon = RISK_ICONS[tier];
        const selected = riskTier === tier;
        return (
          <button
            key={tier}
            type="button"
            onClick={() => onSelect(tier)}
            aria-pressed={selected}
            className={cn(
              "flex flex-col rounded-2xl border p-3.5 text-left transition-colors",
              selected
                ? "border-primary bg-fill-subtle"
                : "border-border-default bg-surface-raised hover:bg-fill-subtle"
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-fill-subtle text-primary">
                <Icon className="h-4 w-4" />
              </span>
              <RadioDot selected={selected} />
            </div>
            <p className="mt-3 text-sm font-semibold text-primary">
              {t(`DashboardEarn.risk.${tier}`)}
            </p>
            <p className="mt-1 text-[13px] leading-snug text-secondary">
              {t(`DashboardEarn.risk.${tier}Description`)}
            </p>
          </button>
        );
      })}
    </div>
  );
}

function StrategyMeta({ strategy }: { strategy: MockEarnStrategy }) {
  const t = useTranslations();
  const liquidityLabel = useLiquidityLabel();
  return (
    <div className="mt-3 flex items-center justify-between text-[13px]">
      <span className="text-primary">
        {formatApy(strategy.currentApy)}{" "}
        <span className="text-secondary">{t(`DashboardEarn.apyType.${strategy.apyType}`)}</span>
      </span>
      <span className="text-secondary">{liquidityLabel(strategy)}</span>
      <span className="text-secondary">{formatUsdCompact(strategy.tvlUsd)}</span>
    </div>
  );
}

function StrategyHeader({ strategy, control }: { strategy: MockEarnStrategy; control: ReactNode }) {
  const t = useTranslations();
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-primary">{strategy.name}</p>
        <p className="mt-0.5 text-xs text-secondary">
          {t(`DashboardEarn.source.${strategy.sourceKind}`)} · {earnCuratorLabel(strategy.curator)}
        </p>
      </div>
      {control}
    </div>
  );
}

function SingleStrategyList({
  choices,
  strategyId,
  onSelect,
}: {
  choices: readonly MockEarnStrategy[];
  strategyId: string | null;
  onSelect: (strategy: MockEarnStrategy) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {choices.map((candidate) => {
        const selected = strategyId === candidate.id;
        return (
          <button
            key={candidate.id}
            type="button"
            onClick={() => onSelect(candidate)}
            aria-pressed={selected}
            className={cn(
              "flex flex-col rounded-2xl border p-3.5 text-left transition-colors",
              selected
                ? "border-primary bg-fill-subtle"
                : "border-border-default bg-surface-raised hover:bg-fill-subtle"
            )}
          >
            <StrategyHeader strategy={candidate} control={<RadioDot selected={selected} />} />
            <StrategyMeta strategy={candidate} />
          </button>
        );
      })}
    </div>
  );
}

function SplitStrategyList({
  choices,
  split,
  onToggle,
  onPctChange,
}: {
  choices: readonly MockEarnStrategy[];
  split: SplitAllocation;
  onToggle: (strategyId: string) => void;
  onPctChange: (strategyId: string, pct: number) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {choices.map((candidate) => {
        const selected = candidate.id in split;
        return (
          <div
            key={candidate.id}
            className={cn(
              "flex flex-col rounded-2xl border p-3.5 transition-colors",
              selected ? "border-primary bg-fill-subtle" : "border-border-default bg-surface-raised"
            )}
          >
            <button
              type="button"
              onClick={() => onToggle(candidate.id)}
              aria-pressed={selected}
              className="text-left"
            >
              <StrategyHeader
                strategy={candidate}
                control={<RadioDot selected={selected} square />}
              />
              <StrategyMeta strategy={candidate} />
            </button>
            {selected ? (
              <div className="mt-3 flex items-center gap-2 border-t border-border-default pt-3">
                <Input
                  size="md"
                  type="number"
                  inputMode="numeric"
                  min="0"
                  max="100"
                  value={String(split[candidate.id] ?? 0)}
                  onChange={(event: ChangeEvent<HTMLInputElement>) =>
                    onPctChange(candidate.id, Number(event.target.value))
                  }
                  className="w-20 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                />
                <span className="text-xs text-secondary">%</span>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function StrategyStep({
  mode,
  choices,
  curators,
  curatorFilter,
  strategyId,
  split,
  onModeChange,
  onCuratorFilter,
  onSelectSingle,
  onToggleSplit,
  onSplitPctChange,
  onDistributeEvenly,
}: {
  mode: AllocationMode;
  choices: readonly MockEarnStrategy[];
  curators: readonly string[];
  curatorFilter: string | null;
  strategyId: string | null;
  split: SplitAllocation;
  onModeChange: (mode: AllocationMode) => void;
  onCuratorFilter: (curator: string | null) => void;
  onSelectSingle: (strategy: MockEarnStrategy) => void;
  onToggleSplit: (strategyId: string) => void;
  onSplitPctChange: (strategyId: string, pct: number) => void;
  onDistributeEvenly: () => void;
}) {
  const t = useTranslations();
  const total = splitTotal(split);
  const selectedCount = Object.keys(split).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedToggle<AllocationMode>
          value={mode}
          onChange={onModeChange}
          options={[
            { value: "single", label: t("DashboardEarn.wizard.modeSingle") },
            { value: "split", label: t("DashboardEarn.wizard.modeSplit") },
          ]}
        />
        {mode === "split" ? (
          <div className="flex items-center gap-3">
            <span
              className={cn(
                "text-xs font-medium",
                total === 100 ? "text-success" : "text-secondary"
              )}
            >
              {t("DashboardEarn.wizard.splitTotal", { pct: total })}
            </span>
            <button
              type="button"
              onClick={onDistributeEvenly}
              disabled={selectedCount === 0}
              className="text-xs font-medium text-primary disabled:opacity-40"
            >
              {t("DashboardEarn.wizard.splitDistributeEvenly")}
            </button>
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-secondary">{t("DashboardEarn.wizard.curatorFilter")}</span>
        <ChipButton active={curatorFilter === null} onClick={() => onCuratorFilter(null)}>
          {t("DashboardEarn.wizard.allCurators")}
        </ChipButton>
        {curators.map((curator) => (
          <ChipButton
            key={curator}
            active={curatorFilter === curator}
            onClick={() => onCuratorFilter(curator)}
          >
            {earnCuratorLabel(curator)}
          </ChipButton>
        ))}
      </div>

      {mode === "split" ? (
        <p className="text-xs text-tertiary">{t("DashboardEarn.wizard.splitHelp")}</p>
      ) : null}

      {choices.length === 0 ? (
        <p className="rounded-md border border-border-default p-4 text-sm text-tertiary">
          {t("DashboardEarn.wizard.noStrategiesForFilters")}
        </p>
      ) : mode === "single" ? (
        <SingleStrategyList choices={choices} strategyId={strategyId} onSelect={onSelectSingle} />
      ) : (
        <SplitStrategyList
          choices={choices}
          split={split}
          onToggle={onToggleSplit}
          onPctChange={onSplitPctChange}
        />
      )}
    </div>
  );
}

function WalletSourceField({
  walletSource,
  walletId,
  byokAddress,
  eligibleWallets,
  onWalletSourceChange,
  onWalletChange,
  onByokAddressChange,
}: {
  walletSource: WalletSource;
  walletId: string;
  byokAddress: string;
  eligibleWallets: typeof MOCK_EARN_WALLETS;
  onWalletSourceChange: (source: WalletSource) => void;
  onWalletChange: (walletId: string) => void;
  onByokAddressChange: (address: string) => void;
}) {
  const t = useTranslations();
  const byokInvalid = byokAddress.length > 0 && !isLikelySolanaAddress(byokAddress);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <Label>{t("DashboardEarn.wizard.walletLabel")}</Label>
        <SegmentedToggle<WalletSource>
          value={walletSource}
          onChange={onWalletSourceChange}
          options={[
            { value: "sdp", label: t("DashboardEarn.wizard.walletSourceSdp"), icon: WalletIcon },
            {
              value: "byok",
              label: t("DashboardEarn.wizard.walletSourceByok"),
              icon: KeyRoundIcon,
            },
          ]}
        />
      </div>

      {walletSource === "sdp" ? (
        <Select
          size="xl"
          className="w-full"
          iconLeft={<WalletIcon />}
          placeholder={t("DashboardEarn.wizard.selectWallet")}
          value={walletId}
          onValueChange={(value) => onWalletChange(value === null ? "" : value)}
        >
          {eligibleWallets.map((candidate) => (
            <SelectItem key={candidate.id} value={candidate.id}>
              {candidate.name}
            </SelectItem>
          ))}
        </Select>
      ) : (
        <>
          <Input
            size="xl"
            iconLeft={<KeyRoundIcon />}
            placeholder={t("DashboardEarn.wizard.byokPlaceholder")}
            value={byokAddress}
            onChange={(event: ChangeEvent<HTMLInputElement>) =>
              onByokAddressChange(event.target.value)
            }
          />
          <p className="text-xs text-tertiary">{t("DashboardEarn.wizard.byokHelp")}</p>
          {byokInvalid ? (
            <p className="text-xs text-error">{t("DashboardEarn.wizard.byokInvalid")}</p>
          ) : null}
        </>
      )}
    </div>
  );
}

function AmountStep({
  walletSource,
  walletId,
  byokAddress,
  eligibleWallets,
  eligibleMints,
  tokenMint,
  amountInput,
  amount,
  amountValid,
  balance,
  legs,
  projectedYield,
  onWalletSourceChange,
  onWalletChange,
  onByokAddressChange,
  onTokenChange,
  onAmountChange,
}: {
  walletSource: WalletSource;
  walletId: string;
  byokAddress: string;
  eligibleWallets: typeof MOCK_EARN_WALLETS;
  eligibleMints: string[];
  tokenMint: string;
  amountInput: string;
  amount: number;
  amountValid: boolean;
  balance: number;
  legs: DepositLeg[];
  projectedYield: number;
  onWalletSourceChange: (source: WalletSource) => void;
  onWalletChange: (walletId: string) => void;
  onByokAddressChange: (address: string) => void;
  onTokenChange: (mint: string) => void;
  onAmountChange: (value: string) => void;
}) {
  const t = useTranslations();
  const showBalance = walletSource === "sdp";

  return (
    <div className="space-y-4">
      <WalletSourceField
        walletSource={walletSource}
        walletId={walletId}
        byokAddress={byokAddress}
        eligibleWallets={eligibleWallets}
        onWalletSourceChange={onWalletSourceChange}
        onWalletChange={onWalletChange}
        onByokAddressChange={onByokAddressChange}
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>{t("DashboardEarn.wizard.tokenLabel")}</Label>
          <Select
            size="xl"
            className="w-full"
            iconLeft={<BanknoteIcon />}
            placeholder={t("DashboardEarn.wizard.selectToken")}
            value={tokenMint}
            onValueChange={(value) => onTokenChange(value === null ? "" : value)}
          >
            {eligibleMints.map((mint) => (
              <SelectItem key={mint} value={mint}>
                {tokenSymbol(mint)}
              </SelectItem>
            ))}
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="earn-deposit-amount">{t("DashboardEarn.wizard.amountFieldLabel")}</Label>
          <Input
            size="xl"
            id="earn-deposit-amount"
            type="number"
            inputMode="decimal"
            step="any"
            min="0"
            placeholder="0.00"
            className="[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            value={amountInput}
            onChange={(event: ChangeEvent<HTMLInputElement>) => onAmountChange(event.target.value)}
            iconRight={
              showBalance ? (
                <button
                  type="button"
                  onClick={() => onAmountChange(String(balance))}
                  className="pointer-events-auto text-xs font-medium text-primary"
                >
                  {t("DashboardEarn.wizard.useMax")}
                </button>
              ) : undefined
            }
          />
        </div>
      </div>

      {showBalance ? (
        <p className="text-xs text-secondary">
          {t("DashboardEarn.wizard.available", {
            amount: formatTokenAmount(balance, tokenMint),
          })}
        </p>
      ) : null}
      {amountInput && !amountValid ? (
        <p className="text-xs text-error">
          {showBalance && amount > balance
            ? t("DashboardEarn.wizard.errorInsufficientBalance")
            : t("DashboardEarn.wizard.errorAmountRequired")}
        </p>
      ) : null}

      {amountValid && legs.length > 0 ? (
        <div className="rounded-md border border-border-default bg-fill-subtle p-3">
          <p className="text-xs text-secondary">{t("DashboardEarn.wizard.projectedYieldTitle")}</p>
          <p className="mt-1 text-sm text-primary">
            {t("DashboardEarn.wizard.projectedYieldPerYear", {
              amount: formatUsd(projectedYield),
            })}
          </p>
          {legs.length > 1 ? (
            <ul className="mt-2 space-y-1 border-t border-border-default pt-2">
              {legs.map((leg) => (
                <li
                  key={leg.strategy.id}
                  className="flex items-center justify-between text-xs text-secondary"
                >
                  <span className="truncate">
                    {leg.strategy.name} · {leg.pct}%
                  </span>
                  <span className="text-primary">
                    {formatTokenAmount(leg.legAmount, tokenMint)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ReviewStep({
  legs,
  walletLabel,
  amount,
  tokenMint,
  projectedYield,
}: {
  legs: DepositLeg[];
  walletLabel: string;
  amount: number;
  tokenMint: string;
  projectedYield: number;
}) {
  const t = useTranslations();
  const liquidityLabel = useLiquidityLabel();
  const single = legs.length === 1 ? legs[0] : undefined;

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border-default p-4">
        {single ? (
          <>
            <SummaryRow
              label={t("DashboardEarn.wizard.summaryStrategy")}
              value={single.strategy.name}
            />
            <SummaryRow
              label={t("DashboardEarn.wizard.summaryCurator")}
              value={earnCuratorLabel(single.strategy.curator)}
            />
            <SummaryRow
              label={t("DashboardEarn.wizard.summaryApy")}
              value={`${formatApy(single.strategy.currentApy)} ${t(
                `DashboardEarn.apyType.${single.strategy.apyType}`
              )}`}
            />
            <SummaryRow
              label={t("DashboardEarn.wizard.summaryLiquidity")}
              value={liquidityLabel(single.strategy)}
            />
          </>
        ) : (
          legs.map((leg) => (
            <SummaryRow
              key={leg.strategy.id}
              label={`${leg.strategy.name} · ${leg.pct}%`}
              value={`${formatTokenAmount(leg.legAmount, tokenMint)} · ${formatApy(
                leg.strategy.currentApy
              )}`}
            />
          ))
        )}
        <SummaryRow label={t("DashboardEarn.wizard.summaryWallet")} value={walletLabel} />
        <SummaryRow
          label={t("DashboardEarn.wizard.summaryAmount")}
          value={formatTokenAmount(amount, tokenMint)}
        />
        <SummaryRow
          label={t("DashboardEarn.wizard.summaryProjectedYield")}
          value={formatUsd(projectedYield)}
        />
      </div>
      <p className="text-xs text-tertiary">{t("DashboardEarn.wizard.mockConfirmNote")}</p>
    </div>
  );
}

function SummaryRail({
  riskTier,
  mode,
  legs,
  walletLabel,
  amount,
  amountValid,
  tokenMint,
  showFunding,
}: {
  riskTier: EarnRiskTier | null;
  mode: AllocationMode;
  legs: DepositLeg[];
  walletLabel: string | undefined;
  amount: number;
  amountValid: boolean;
  tokenMint: string;
  showFunding: boolean;
}) {
  const t = useTranslations();

  return (
    <aside className="hidden lg:block">
      <div className="sticky top-2 rounded-lg border border-border-default bg-surface-raised p-4">
        <h3 className="text-sm font-medium text-primary">
          {t("DashboardEarn.wizard.summaryTitle")}
        </h3>
        {riskTier === null && legs.length === 0 ? (
          <p className="mt-3 text-xs text-tertiary">{t("DashboardEarn.wizard.summaryEmpty")}</p>
        ) : (
          <div className="mt-3">
            {riskTier ? (
              <SummaryRow
                label={t("DashboardEarn.wizard.summaryRisk")}
                value={t(`DashboardEarn.risk.${riskTier}`)}
              />
            ) : null}
            {legs.length === 1 ? (
              <SummaryRow
                label={t("DashboardEarn.wizard.summaryStrategy")}
                value={legs[0].strategy.name}
              />
            ) : null}
            {legs.length > 1 ? (
              <SummaryRow
                label={t("DashboardEarn.wizard.summaryAllocation")}
                value={t("DashboardEarn.wizard.summaryStrategyCount", { count: legs.length })}
              />
            ) : null}
            {mode === "split" && legs.length === 0 ? (
              <SummaryRow
                label={t("DashboardEarn.wizard.summaryAllocation")}
                value={t("DashboardEarn.wizard.modeSplit")}
              />
            ) : null}
            {walletLabel && showFunding ? (
              <SummaryRow label={t("DashboardEarn.wizard.summaryWallet")} value={walletLabel} />
            ) : null}
            {amountValid && showFunding ? (
              <SummaryRow
                label={t("DashboardEarn.wizard.summaryAmount")}
                value={formatTokenAmount(amount, tokenMint)}
              />
            ) : null}
          </div>
        )}
      </div>
    </aside>
  );
}

function SuccessPanel({
  legs,
  amount,
  tokenMint,
  projectedYield,
}: {
  legs: DepositLeg[];
  amount: number;
  tokenMint: string;
  projectedYield: number;
}) {
  const t = useTranslations();
  const router = useDashboardRouter();

  return (
    <div className="flex h-full min-h-0 w-full items-center justify-center p-6">
      <div className="w-full max-w-md rounded-lg border border-border-default bg-surface-raised p-6 text-center">
        <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-fill-subtle text-primary">
          <CheckIcon className="h-5 w-5" />
        </span>
        <h2 className="mt-4 text-lg font-medium text-primary">
          {t("DashboardEarn.wizard.successTitle")}
        </h2>
        <p className="mt-1 text-sm text-secondary">
          {t("DashboardEarn.wizard.successDescription")}
        </p>
        <div className="mt-4 rounded-md border border-border-default p-3 text-left">
          {legs.map((leg) => (
            <SummaryRow
              key={leg.strategy.id}
              label={leg.strategy.name}
              value={formatTokenAmount(leg.legAmount, tokenMint)}
            />
          ))}
          <SummaryRow
            label={t("DashboardEarn.wizard.summaryAmount")}
            value={formatTokenAmount(amount, tokenMint)}
          />
          <SummaryRow
            label={t("DashboardEarn.wizard.summaryProjectedYield")}
            value={formatUsd(projectedYield)}
          />
        </div>
        <div className="mt-5 flex items-center justify-center gap-3">
          <Button
            variant="secondary"
            onClick={() => router.push("/dashboard/markets/earn/deposit")}
          >
            {t("DashboardEarn.wizard.successAnother")}
          </Button>
          <Button onClick={() => router.push("/dashboard/markets/earn")}>
            {t("DashboardEarn.wizard.viewPositions")}
          </Button>
        </div>
      </div>
    </div>
  );
}

// Derivation kept out of the component so its cognitive complexity stays low.
interface WizardState {
  mode: AllocationMode;
  strategyId: string | null;
  split: SplitAllocation;
  walletSource: WalletSource;
  walletId: string;
  byokAddress: string;
  tokenMint: string;
  amountInput: string;
}

function computeSelected(
  mode: AllocationMode,
  singleStrategy: MockEarnStrategy | undefined,
  split: SplitAllocation
): MockEarnStrategy[] {
  if (mode === "single") {
    return singleStrategy ? [singleStrategy] : [];
  }
  return selectedSplitStrategies(split);
}

function computeEligibleMints(
  mode: AllocationMode,
  singleStrategy: MockEarnStrategy | undefined,
  selected: MockEarnStrategy[]
): string[] {
  if (mode === "single") {
    return singleStrategy?.depositMints ?? [];
  }
  return commonDepositMints(selected);
}

function computeLegs(
  mode: AllocationMode,
  singleStrategy: MockEarnStrategy | undefined,
  split: SplitAllocation,
  amount: number
): DepositLeg[] {
  if (mode === "single") {
    return singleStrategy ? [{ strategy: singleStrategy, pct: 100, legAmount: amount }] : [];
  }
  return buildLegs(split, amount);
}

function deriveDeposit(s: WizardState) {
  const singleStrategy = s.strategyId ? getMockStrategy(s.strategyId) : undefined;
  const selected = computeSelected(s.mode, singleStrategy, s.split);
  const eligibleMints = computeEligibleMints(s.mode, singleStrategy, selected);
  const amount = Number(s.amountInput);
  const wallet = MOCK_EARN_WALLETS.find((candidate) => candidate.id === s.walletId);
  const balance =
    s.walletSource === "sdp" ? (wallet?.balances[s.tokenMint] ?? 0) : Number.POSITIVE_INFINITY;
  const amountValid =
    Number.isFinite(amount) && amount > 0 && (s.walletSource === "byok" || amount <= balance);
  const walletReady =
    s.walletSource === "sdp" ? wallet !== undefined : isLikelySolanaAddress(s.byokAddress);
  const legs = computeLegs(s.mode, singleStrategy, s.split, amount);
  const projectedYield = legs.reduce(
    (sum, leg) => sum + projectYearlyYield(leg.legAmount, leg.strategy.currentApy),
    0
  );
  const walletLabel =
    s.walletSource === "sdp"
      ? wallet?.name
      : `${s.byokAddress.slice(0, 4)}…${s.byokAddress.slice(-4)} (BYOK)`;
  const splitReady =
    Object.keys(s.split).length > 0 && splitTotal(s.split) === 100 && eligibleMints.length > 0;
  const strategyReady = s.mode === "single" ? singleStrategy !== undefined : splitReady;
  const amountStepReady = amountValid && walletReady && eligibleMints.includes(s.tokenMint);
  return {
    eligibleMints,
    amount,
    wallet,
    balance,
    amountValid,
    legs,
    projectedYield,
    walletLabel,
    strategyReady,
    amountStepReady,
  };
}

type WizardBodyProps = {
  stepId: StepId;
  state: WizardState;
  derived: ReturnType<typeof deriveDeposit>;
  riskTier: EarnRiskTier | null;
  curatorFilter: string | null;
  choices: readonly MockEarnStrategy[];
  curators: readonly string[];
  onRiskTier: (tier: EarnRiskTier) => void;
  onModeChange: (mode: AllocationMode) => void;
  onCuratorFilter: (curator: string | null) => void;
  onSelectSingle: (strategy: MockEarnStrategy) => void;
  onToggleSplit: (strategyId: string) => void;
  onSplitPctChange: (strategyId: string, pct: number) => void;
  onDistributeEvenly: () => void;
  onWalletSourceChange: (source: WalletSource) => void;
  onWalletChange: (walletId: string) => void;
  onByokAddressChange: (address: string) => void;
  onTokenChange: (mint: string) => void;
  onAmountChange: (value: string) => void;
};

function WizardStepBody(props: WizardBodyProps) {
  const { stepId, state, derived } = props;
  if (stepId === "profile") {
    return <ProfileStep riskTier={props.riskTier} onSelect={props.onRiskTier} />;
  }
  if (stepId === "strategy") {
    return (
      <StrategyStep
        mode={state.mode}
        choices={props.choices}
        curators={props.curators}
        curatorFilter={props.curatorFilter}
        strategyId={state.strategyId}
        split={state.split}
        onModeChange={props.onModeChange}
        onCuratorFilter={props.onCuratorFilter}
        onSelectSingle={props.onSelectSingle}
        onToggleSplit={props.onToggleSplit}
        onSplitPctChange={props.onSplitPctChange}
        onDistributeEvenly={props.onDistributeEvenly}
      />
    );
  }
  if (stepId === "amount") {
    return (
      <AmountStep
        walletSource={state.walletSource}
        walletId={state.walletId}
        byokAddress={state.byokAddress}
        eligibleWallets={MOCK_EARN_WALLETS}
        eligibleMints={derived.eligibleMints}
        tokenMint={state.tokenMint}
        amountInput={state.amountInput}
        amount={derived.amount}
        amountValid={derived.amountValid}
        balance={derived.balance}
        legs={derived.legs}
        projectedYield={derived.projectedYield}
        onWalletSourceChange={props.onWalletSourceChange}
        onWalletChange={props.onWalletChange}
        onByokAddressChange={props.onByokAddressChange}
        onTokenChange={props.onTokenChange}
        onAmountChange={props.onAmountChange}
      />
    );
  }
  return (
    <ReviewStep
      legs={derived.legs}
      walletLabel={derived.walletLabel ?? ""}
      amount={derived.amount}
      tokenMint={state.tokenMint}
      projectedYield={derived.projectedYield}
    />
  );
}

interface EarnDepositWizardProps {
  initialStrategyId?: string;
}

export function EarnDepositWizard({ initialStrategyId }: EarnDepositWizardProps) {
  const t = useTranslations();
  const router = useDashboardRouter();

  const initialStrategy = initialStrategyId ? getMockStrategy(initialStrategyId) : undefined;

  const [step, setStep] = useState(initialStrategy ? 2 : 0);
  const [direction, setDirection] = useState(1);
  const [mode, setMode] = useState<AllocationMode>("single");
  const [riskTier, setRiskTier] = useState<EarnRiskTier | null>(initialStrategy?.riskTier ?? null);
  const [curatorFilter, setCuratorFilter] = useState<string | null>(null);
  const [strategyId, setStrategyId] = useState<string | null>(initialStrategy?.id ?? null);
  const [split, setSplit] = useState<SplitAllocation>({});
  const [walletSource, setWalletSource] = useState<WalletSource>("sdp");
  const [walletId, setWalletId] = useState<string>(MOCK_EARN_WALLETS[0]?.id ?? "");
  const [byokAddress, setByokAddress] = useState("");
  const [tokenMint, setTokenMint] = useState<string>(
    initialStrategy?.depositMints[0] ?? DEFAULT_DEPOSIT_MINT
  );
  const [amountInput, setAmountInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  const currentStepId = STEP_IDS[step] ?? "profile";
  const state: WizardState = {
    mode,
    strategyId,
    split,
    walletSource,
    walletId,
    byokAddress,
    tokenMint,
    amountInput,
  };
  const derived = deriveDeposit(state);

  const curators = useMemo(
    () => [...new Set(MOCK_EARN_STRATEGIES.map((candidate) => candidate.curator))],
    []
  );
  const strategyChoices = MOCK_EARN_STRATEGIES.filter(
    (candidate) =>
      (riskTier === null || candidate.riskTier === riskTier) &&
      (curatorFilter === null || candidate.curator === curatorFilter)
  );

  const stepReady: Record<StepId, boolean> = {
    profile: riskTier !== null,
    strategy: derived.strategyReady,
    amount: derived.amountStepReady,
    review: true,
  };
  const canContinue = stepReady[currentStepId];

  const selectSingle = (candidate: MockEarnStrategy) => {
    setStrategyId(candidate.id);
    if (!candidate.depositMints.includes(tokenMint)) {
      setTokenMint(candidate.depositMints[0] ?? DEFAULT_DEPOSIT_MINT);
    }
  };

  const toggleSplit = (id: string) => {
    setSplit((prev) => {
      const nextIds =
        id in prev ? Object.keys(prev).filter((k) => k !== id) : [...Object.keys(prev), id];
      return evenSplit(nextIds);
    });
  };

  const setSplitPct = (id: string, pct: number) => {
    setSplit((prev) => ({
      ...prev,
      [id]: Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0,
    }));
  };

  const goNext = () => {
    if (step >= STEP_IDS.length - 1) return;
    setDirection(1);
    setStep(step + 1);
  };

  const goBack = () => {
    if (step === 0) return;
    setDirection(-1);
    setStep(step - 1);
  };

  const submit = () => {
    if (!canContinue || derived.legs.length === 0) return;
    const fundingWalletId = walletSource === "sdp" ? (derived.wallet?.id ?? "") : byokAddress;
    setSubmitting(true);
    window.setTimeout(() => {
      for (const leg of derived.legs) {
        addMockPosition({
          strategyId: leg.strategy.id,
          walletId: fundingWalletId,
          tokenMint,
          amount: leg.legAmount,
        });
      }
      setSubmitting(false);
      setConfirmed(true);
    }, 650);
  };

  if (confirmed && derived.legs.length > 0) {
    return (
      <SuccessPanel
        legs={derived.legs}
        amount={derived.amount}
        tokenMint={tokenMint}
        projectedYield={derived.projectedYield}
      />
    );
  }

  const primaryButton =
    currentStepId === "review" ? (
      <Button
        type="button"
        onClick={submit}
        disabled={submitting || !canContinue}
        iconLeft={submitting ? <Loader2Icon className="animate-spin" /> : undefined}
      >
        {submitting ? t("DashboardEarn.wizard.confirming") : t("DashboardEarn.wizard.confirm")}
      </Button>
    ) : (
      <Button type="button" onClick={goNext} disabled={!canContinue} iconRight={<ArrowRightIcon />}>
        {t("DashboardEarn.wizard.next")}
      </Button>
    );

  return (
    <PaymentsWizardFrame
      steps={STEP_IDS.map((stepId) => ({
        label: t(stepMeta[stepId].label),
        title: t(stepMeta[stepId].title),
      }))}
      currentStep={step}
      progressLabel={t("DashboardEarn.wizard.stepProgress", {
        current: step + 1,
        total: STEP_IDS.length,
      })}
      description={t(stepMeta[currentStepId].description)}
      maxWidthClassName="max-w-4xl"
      footer={
        <div className="flex items-center justify-between gap-3">
          <Button
            type="button"
            variant="secondary"
            disabled={submitting}
            onClick={step === 0 ? () => router.push("/dashboard/markets/earn") : goBack}
            iconLeft={step === 0 ? undefined : <ArrowLeftIcon />}
          >
            {step === 0 ? t("DashboardEarn.wizard.cancel") : t("DashboardEarn.wizard.back")}
          </Button>
          {primaryButton}
        </div>
      }
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_16rem]">
        <div className="relative min-h-[20rem] overflow-hidden">
          <AnimatePresence mode="wait" custom={direction}>
            <motion.div
              key={currentStepId}
              custom={direction}
              variants={stepVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              transition={{ duration: 0.18, ease: "easeOut" }}
              className="space-y-6 px-1 py-1"
            >
              <WizardStepBody
                stepId={currentStepId}
                state={state}
                derived={derived}
                riskTier={riskTier}
                curatorFilter={curatorFilter}
                choices={strategyChoices}
                curators={curators}
                onRiskTier={setRiskTier}
                onModeChange={setMode}
                onCuratorFilter={setCuratorFilter}
                onSelectSingle={selectSingle}
                onToggleSplit={toggleSplit}
                onSplitPctChange={setSplitPct}
                onDistributeEvenly={() => setSplit((prev) => evenSplit(Object.keys(prev)))}
                onWalletSourceChange={setWalletSource}
                onWalletChange={setWalletId}
                onByokAddressChange={setByokAddress}
                onTokenChange={setTokenMint}
                onAmountChange={setAmountInput}
              />
            </motion.div>
          </AnimatePresence>
        </div>

        <SummaryRail
          riskTier={riskTier}
          mode={mode}
          legs={derived.legs}
          walletLabel={derived.walletLabel}
          amount={derived.amount}
          amountValid={derived.amountValid}
          tokenMint={tokenMint}
          showFunding={step >= 2}
        />
      </div>
    </PaymentsWizardFrame>
  );
}
