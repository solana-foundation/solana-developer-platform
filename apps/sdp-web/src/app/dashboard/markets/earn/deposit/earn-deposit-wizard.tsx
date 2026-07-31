"use client";

import { earnCuratorLabel } from "@sdp/types";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BanknoteIcon,
  BriefcaseBusinessIcon,
  CheckCircle2Icon,
  CheckIcon,
  CopyIcon,
  LandmarkIcon,
  Layers3Icon,
  Loader2Icon,
  LockKeyholeIcon,
  PieChartIcon,
  ScaleIcon,
  ShieldCheckIcon,
  ShieldIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  TrendingUpIcon,
  UsersIcon,
  WalletCardsIcon,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ChangeEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import { PaymentsWizardFrame } from "@/app/dashboard/payments/payments-wizard-frame";
import { Badge } from "@/components/ui/badge";
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
  MOCK_EARN_STRATEGIES,
  MOCK_EARN_WALLETS,
  type MockEarnStrategy,
  type MockEarnWallet,
  projectYearlyYield,
  tokenSymbol,
} from "../earn-mock-data";
import { addMockPosition } from "../earn-mock-positions";
import {
  type AllocationMode,
  type AssetPreference,
  allocationTotal,
  canAddCompatibleStrategy,
  type EarnDestination,
  evenAllocation,
  selectedStrategies,
  selectionShape,
  strategyMatchesPreferences,
  weightedApy,
} from "./earn-setup-model";

type SetupStep = "wallet" | "profile" | "strategy" | "allocation" | "review";
type PostSetupScreen = "treasury" | "retail-preview" | "retail-integration" | "vault-live";
type WalletProvider = MockEarnWallet["provider"];
type Allocation = Record<string, number>;

interface DepositLeg {
  strategy: MockEarnStrategy;
  pct: number;
  legAmount: number;
}

const SETUP_PROGRESS = ["wallet", "profile", "strategy", "review"] as const;

const stepMeta: Record<SetupStep, { title: MessageKey; description: MessageKey }> = {
  wallet: {
    title: "DashboardEarn.setup.walletTitle",
    description: "DashboardEarn.setup.walletDescription",
  },
  profile: {
    title: "DashboardEarn.setup.preferencesTitle",
    description: "DashboardEarn.setup.preferencesDescription",
  },
  strategy: {
    title: "DashboardEarn.setup.strategiesTitle",
    description: "DashboardEarn.setup.strategiesDescription",
  },
  allocation: {
    title: "DashboardEarn.setup.allocationTitle",
    description: "DashboardEarn.setup.allocationDescription",
  },
  review: {
    title: "DashboardEarn.setup.reviewTitle",
    description: "DashboardEarn.setup.reviewDescription",
  },
};

const RISK_ICONS: Record<EarnRiskTier, typeof ShieldIcon> = {
  conservative: ShieldIcon,
  balanced: ScaleIcon,
  enhanced: TrendingUpIcon,
};

const PROVIDERS: readonly {
  id: WalletProvider;
  label: MessageKey;
  description: MessageKey;
  monogram: string;
}[] = [
  {
    id: "fireblocks",
    label: "DashboardEarn.setup.providerFireblocks",
    description: "DashboardEarn.setup.fireblocksDescription",
    monogram: "F",
  },
  {
    id: "anchorage",
    label: "DashboardEarn.setup.providerAnchorage",
    description: "DashboardEarn.setup.anchorageDescription",
    monogram: "A",
  },
];

const EARN_SDK_PACKAGE = "@sdp/earn";

const SDK_SNIPPET = `import { createEarnClient } from "${EARN_SDK_PACKAGE}";

const earn = createEarnClient({ apiKey });

const experience = await earn.experiences.mount({
  configurationId: "earn_config_sandbox_01",
  wallet: user.wallet,
});`;

const API_SNIPPET = `POST /v1/earn/quotes
Authorization: Bearer $SDP_API_KEY
Content-Type: application/json

{
  "configurationId": "earn_config_sandbox_01",
  "wallet": "<end-user-wallet>",
  "amount": "250.00"
}`;

const INTEGRATION_TABS = { sdk: "sdk", api: "api" } as const;
type IntegrationTab = (typeof INTEGRATION_TABS)[keyof typeof INTEGRATION_TABS];

const INTEGRATION_CHECKLIST: readonly MessageKey[] = [
  "DashboardEarn.setup.secureKey",
  "DashboardEarn.setup.mountExperience",
  "DashboardEarn.setup.testQuote",
];

function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-6)}`;
}

function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function buildLegs(
  strategies: readonly MockEarnStrategy[],
  allocation: Allocation,
  amount: number
): DepositLeg[] {
  return strategies.map((strategy) => {
    const pct = allocation[strategy.id] ?? 0;
    return { strategy, pct, legAmount: amount * (pct / 100) };
  });
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

function SelectionMark({ selected }: { selected: boolean }) {
  return (
    <span
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors",
        selected
          ? "border-primary bg-primary text-on-primary"
          : "border-border-strong bg-surface-raised text-transparent"
      )}
      aria-hidden="true"
    >
      <CheckIcon className="size-3" />
    </span>
  );
}

function SummaryRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border-subtle py-2.5 text-sm last:border-b-0">
      <span className="shrink-0 text-secondary">{label}</span>
      <span className="min-w-0 text-right text-primary">{value}</span>
    </div>
  );
}

function SectionHeading({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-fill-subtle text-secondary">
        {icon}
      </span>
      <div className="min-w-0">
        <h3 className="text-sm font-medium text-primary">{title}</h3>
        {description ? (
          <p className="mt-0.5 text-[13px] leading-5 text-tertiary">{description}</p>
        ) : null}
      </div>
    </div>
  );
}

function ProviderMark({ label }: { label: string }) {
  return (
    <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border-subtle bg-fill-subtle text-sm font-semibold text-primary">
      {label}
    </span>
  );
}

function WalletStep({
  provider,
  walletId,
  onProviderChange,
  onWalletChange,
}: {
  provider: WalletProvider | null;
  walletId: string;
  onProviderChange: (provider: WalletProvider) => void;
  onWalletChange: (walletId: string) => void;
}) {
  const t = useTranslations();
  const reduceMotion = useReducedMotion();
  const visibleWallets = provider
    ? MOCK_EARN_WALLETS.filter((wallet) => wallet.provider === provider)
    : [];

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2">
        {PROVIDERS.map((candidate) => {
          const selected = candidate.id === provider;
          return (
            <button
              key={candidate.id}
              type="button"
              aria-pressed={selected}
              onClick={() => onProviderChange(candidate.id)}
              className={cn(
                "flex min-h-28 items-start gap-3 rounded-2xl border p-4 text-left transition-[border-color,background-color,box-shadow] duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none",
                selected
                  ? "border-primary bg-fill-subtle shadow-sm"
                  : "border-border-default bg-surface-raised hover:border-border-strong hover:bg-fill-subtle"
              )}
            >
              <ProviderMark label={candidate.monogram} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-primary">{t(candidate.label)}</span>
                  <SelectionMark selected={selected} />
                </span>
                <span className="mt-1 block text-[13px] leading-5 text-secondary">
                  {t(candidate.description)}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <AnimatePresence initial={false} mode="wait">
        {provider ? (
          <motion.div
            key={provider}
            initial={reduceMotion ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
            transition={{ duration: reduceMotion ? 0 : 0.18, ease: "easeOut" }}
            className="space-y-3"
          >
            <div className="flex items-center justify-between gap-3">
              <Label>{t("DashboardEarn.setup.availableWallets")}</Label>
              <span className="inline-flex items-center gap-1.5 text-xs text-success">
                <CheckCircle2Icon className="size-3.5" />
                {t("DashboardEarn.setup.providerConnected")}
              </span>
            </div>
            <div className="overflow-hidden rounded-2xl border border-border-default bg-surface-raised">
              {visibleWallets.map((wallet) => {
                const selected = wallet.id === walletId;
                const totalStablecoinBalance = Object.values(wallet.balances).reduce(
                  (sum, balance) => sum + balance,
                  0
                );
                return (
                  <button
                    key={wallet.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => onWalletChange(wallet.id)}
                    className={cn(
                      "grid w-full gap-3 px-4 py-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center",
                      selected ? "bg-fill-subtle" : "hover:bg-fill-subtle"
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-fill text-secondary">
                        <WalletCardsIcon className="size-4" />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-primary">
                          {wallet.name}
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-tertiary">
                          {t("DashboardEarn.setup.walletNetwork", {
                            address: shortenAddress(wallet.address),
                          })}
                        </span>
                      </span>
                    </span>
                    <span className="flex items-center justify-between gap-4 pl-12 sm:justify-end sm:pl-0">
                      <span className="text-right">
                        <span className="block text-sm text-primary">
                          {formatUsd(totalStablecoinBalance)}
                        </span>
                        <span className="mt-0.5 block text-xs text-tertiary">
                          {t("DashboardEarn.setup.availableBalance")}
                        </span>
                      </span>
                      <SelectionMark selected={selected} />
                    </span>
                  </button>
                );
              })}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div className="flex items-start gap-2.5 rounded-xl border border-border-subtle bg-fill-subtle px-3.5 py-3 text-[13px] leading-5 text-secondary">
        <LockKeyholeIcon className="mt-0.5 size-4 shrink-0" />
        <p>{t("DashboardEarn.setup.walletMockNotice")}</p>
      </div>
    </div>
  );
}

function ChoiceCard({
  selected,
  icon,
  title,
  description,
  onClick,
}: {
  selected: boolean;
  icon: ReactNode;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "flex min-h-28 flex-col rounded-2xl border p-4 text-left transition-[border-color,background-color,box-shadow] duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none",
        selected
          ? "border-primary bg-fill-subtle shadow-sm"
          : "border-border-default bg-surface-raised hover:border-border-strong hover:bg-fill-subtle"
      )}
    >
      <span className="flex w-full items-start justify-between gap-3">
        <span className="flex size-9 items-center justify-center rounded-lg bg-fill text-secondary">
          {icon}
        </span>
        <SelectionMark selected={selected} />
      </span>
      <span className="mt-3 text-sm font-medium text-primary">{title}</span>
      <span className="mt-1 text-[13px] leading-5 text-secondary">{description}</span>
    </button>
  );
}

function QuestionnaireStep({
  destination,
  riskTier,
  source,
  onDestinationChange,
  onRiskTierChange,
  onSourceChange,
  onBrowseAll,
}: {
  destination: EarnDestination | null;
  riskTier: EarnRiskTier | null;
  source: AssetPreference;
  onDestinationChange: (destination: EarnDestination | null) => void;
  onRiskTierChange: (riskTier: EarnRiskTier | null) => void;
  onSourceChange: (source: AssetPreference) => void;
  onBrowseAll: () => void;
}) {
  const t = useTranslations();

  return (
    <div className="space-y-7">
      <section className="space-y-3">
        <SectionHeading
          icon={<BriefcaseBusinessIcon className="size-4" />}
          title={t("DashboardEarn.setup.useCaseTitle")}
          description={t("DashboardEarn.setup.useCaseDescription")}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <ChoiceCard
            selected={destination === "treasury"}
            icon={<LandmarkIcon className="size-4" />}
            title={t("DashboardEarn.setup.destinationTreasury")}
            description={t("DashboardEarn.setup.destinationTreasuryDescription")}
            onClick={() => onDestinationChange(destination === "treasury" ? null : "treasury")}
          />
          <ChoiceCard
            selected={destination === "retail"}
            icon={<UsersIcon className="size-4" />}
            title={t("DashboardEarn.setup.destinationRetail")}
            description={t("DashboardEarn.setup.destinationRetailDescription")}
            onClick={() => onDestinationChange(destination === "retail" ? null : "retail")}
          />
        </div>
      </section>

      <section className="space-y-3">
        <SectionHeading
          icon={<ShieldCheckIcon className="size-4" />}
          title={t("DashboardEarn.setup.riskQuestionTitle")}
          description={t("DashboardEarn.setup.riskQuestionDescription")}
        />
        <div className="grid gap-3 sm:grid-cols-3">
          {EARN_RISK_TIERS.map((tier) => {
            const Icon = RISK_ICONS[tier];
            return (
              <ChoiceCard
                key={tier}
                selected={riskTier === tier}
                icon={<Icon className="size-4" />}
                title={t(`DashboardEarn.risk.${tier}`)}
                description={t(`DashboardEarn.risk.${tier}ShortDescription`)}
                onClick={() => onRiskTierChange(riskTier === tier ? null : tier)}
              />
            );
          })}
        </div>
      </section>

      <section className="space-y-3">
        <SectionHeading
          icon={<Layers3Icon className="size-4" />}
          title={t("DashboardEarn.setup.yieldSourceTitle")}
          description={t("DashboardEarn.setup.yieldSourceDescription")}
        />
        <div className="grid gap-3 sm:grid-cols-3">
          <ChoiceCard
            selected={source === "all"}
            icon={<SparklesIcon className="size-4" />}
            title={t("DashboardEarn.setup.sourceAll")}
            description={t("DashboardEarn.setup.sourceAllDescription")}
            onClick={() => onSourceChange("all")}
          />
          <ChoiceCard
            selected={source === "rwa"}
            icon={<LandmarkIcon className="size-4" />}
            title={t("DashboardEarn.source.rwa")}
            description={t("DashboardEarn.setup.sourceRwaDescription")}
            onClick={() => onSourceChange("rwa")}
          />
          <ChoiceCard
            selected={source === "defi"}
            icon={<PieChartIcon className="size-4" />}
            title={t("DashboardEarn.source.defi")}
            description={t("DashboardEarn.setup.sourceDefiDescription")}
            onClick={() => onSourceChange("defi")}
          />
        </div>
      </section>

      <div className="flex flex-col gap-3 border-t border-border-subtle pt-5 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-xl text-[13px] leading-5 text-tertiary">
          {t("DashboardEarn.setup.preferencesAreFilters")}
        </p>
        <Button type="button" variant="ghost" size="sm" onClick={onBrowseAll}>
          {t("DashboardEarn.setup.browseAll")}
        </Button>
      </div>
    </div>
  );
}

function FilterButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none",
        active
          ? "border-primary bg-primary text-on-primary"
          : "border-border-default bg-surface-raised text-secondary hover:border-border-strong hover:text-primary"
      )}
    >
      {children}
    </button>
  );
}

function StrategyCard({
  strategy,
  selected,
  disabled,
  onToggle,
}: {
  strategy: MockEarnStrategy;
  selected: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const t = useTranslations();
  const liquidityLabel = useLiquidityLabel();
  const incompatibilityId = `${strategy.id}-incompatibility`;

  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-disabled={disabled}
      aria-label={t("DashboardEarn.setup.strategyCardLabel", {
        strategy: strategy.name,
        apy: formatApy(strategy.currentApy),
        risk: t(`DashboardEarn.risk.${strategy.riskTier}`),
        source: t(`DashboardEarn.source.${strategy.sourceKind}`),
        curator: earnCuratorLabel(strategy.curator),
        liquidity: liquidityLabel(strategy),
        tvl: formatUsdCompact(strategy.tvlUsd),
        assets: strategy.depositMints.map(tokenSymbol).join(", "),
      })}
      aria-describedby={disabled ? incompatibilityId : undefined}
      onClick={onToggle}
      className={cn(
        "group flex min-h-48 flex-col rounded-2xl border p-4 text-left transition-[border-color,background-color,box-shadow,opacity] duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none",
        selected
          ? "border-primary bg-fill-subtle shadow-sm"
          : disabled
            ? "cursor-not-allowed border-border-default bg-fill-subtle"
            : "border-border-default bg-surface-raised hover:border-border-strong hover:bg-fill-subtle"
      )}
    >
      <span className="flex items-start justify-between gap-4">
        <span className="min-w-0">
          <span className="text-[11px] font-semibold tracking-[0.08em] text-tertiary uppercase">
            {t(`DashboardEarn.source.${strategy.sourceKind}`)} ·{" "}
            {t(`DashboardEarn.risk.${strategy.riskTier}`)}
          </span>
          <span className="mt-1.5 block text-sm font-medium text-primary">{strategy.name}</span>
          <span className="mt-1 block text-xs text-secondary">
            {t("DashboardEarn.setup.curatedBy", { curator: earnCuratorLabel(strategy.curator) })}
          </span>
        </span>
        <SelectionMark selected={selected} />
      </span>

      <span className="mt-5 flex items-end justify-between gap-4">
        <span>
          <span className="block text-2xl leading-none font-medium tracking-tight text-primary">
            {formatApy(strategy.currentApy)}
          </span>
          <span className="mt-1 block text-xs text-tertiary">
            {t("DashboardEarn.setup.estimatedApy")}
          </span>
        </span>
        <span className="text-right text-xs leading-5 text-secondary">
          <span className="block">{liquidityLabel(strategy)}</span>
          <span className="block text-tertiary">
            {t("DashboardEarn.setup.tvl", { value: formatUsdCompact(strategy.tvlUsd) })}
          </span>
        </span>
      </span>

      <span className="mt-auto flex flex-wrap gap-1.5 border-t border-border-subtle pt-3">
        {strategy.depositMints.map((mint) => (
          <span
            key={mint}
            className="rounded-md bg-fill px-2 py-1 text-[11px] font-medium text-secondary"
          >
            {tokenSymbol(mint)}
          </span>
        ))}
        {disabled ? (
          <span id={incompatibilityId} className="ml-auto text-[11px] font-medium text-warning">
            {t("DashboardEarn.setup.incompatibleAsset")}
          </span>
        ) : null}
      </span>
    </button>
  );
}

function StrategyStep({
  selectedIds,
  riskTier,
  source,
  curator,
  onSelectedIdsChange,
  onRiskTierChange,
  onSourceChange,
  onCuratorChange,
}: {
  selectedIds: readonly string[];
  riskTier: EarnRiskTier | null;
  source: AssetPreference;
  curator: string | null;
  onSelectedIdsChange: (ids: string[]) => void;
  onRiskTierChange: (tier: EarnRiskTier | null) => void;
  onSourceChange: (source: AssetPreference) => void;
  onCuratorChange: (curator: string | null) => void;
}) {
  const t = useTranslations();
  const curators = useMemo(
    () => [...new Set(MOCK_EARN_STRATEGIES.map((strategy) => strategy.curator))],
    []
  );
  const choices = MOCK_EARN_STRATEGIES.filter(
    (strategy) =>
      selectedIds.includes(strategy.id) ||
      (strategyMatchesPreferences(strategy, { riskTier, source }) &&
        (curator === null || strategy.curator === curator))
  );
  const selected = selectedStrategies(selectedIds, MOCK_EARN_STRATEGIES);
  const shape = selectionShape(selected);

  const toggle = (strategyId: string) => {
    if (selectedIds.includes(strategyId)) {
      onSelectedIdsChange(selectedIds.filter((id) => id !== strategyId));
      return;
    }
    if (!canAddCompatibleStrategy(selectedIds, strategyId, MOCK_EARN_STRATEGIES)) return;
    onSelectedIdsChange([...selectedIds, strategyId]);
  };

  return (
    <div className="space-y-5">
      <div className="space-y-3 rounded-2xl border border-border-default bg-fill-subtle p-4">
        <fieldset className="flex flex-wrap items-center gap-2">
          <legend className="sr-only">{t("DashboardEarn.setup.riskFilter")}</legend>
          <span aria-hidden="true" className="mr-1 text-xs font-medium text-secondary">
            {t("DashboardEarn.setup.riskFilter")}
          </span>
          <FilterButton active={riskTier === null} onClick={() => onRiskTierChange(null)}>
            {t("DashboardEarn.setup.all")}
          </FilterButton>
          {EARN_RISK_TIERS.map((tier) => (
            <FilterButton
              key={tier}
              active={riskTier === tier}
              onClick={() => onRiskTierChange(tier)}
            >
              {t(`DashboardEarn.risk.${tier}`)}
            </FilterButton>
          ))}
        </fieldset>
        <fieldset className="flex flex-wrap items-center gap-2">
          <legend className="sr-only">{t("DashboardEarn.setup.sourceFilter")}</legend>
          <span aria-hidden="true" className="mr-1 text-xs font-medium text-secondary">
            {t("DashboardEarn.setup.sourceFilter")}
          </span>
          <FilterButton active={source === "all"} onClick={() => onSourceChange("all")}>
            {t("DashboardEarn.setup.all")}
          </FilterButton>
          <FilterButton active={source === "rwa"} onClick={() => onSourceChange("rwa")}>
            {t("DashboardEarn.source.rwa")}
          </FilterButton>
          <FilterButton active={source === "defi"} onClick={() => onSourceChange("defi")}>
            {t("DashboardEarn.source.defi")}
          </FilterButton>
        </fieldset>
        <fieldset className="flex flex-wrap items-center gap-2">
          <legend className="sr-only">{t("DashboardEarn.setup.curatorFilter")}</legend>
          <span aria-hidden="true" className="mr-1 text-xs font-medium text-secondary">
            {t("DashboardEarn.setup.curatorFilter")}
          </span>
          <FilterButton active={curator === null} onClick={() => onCuratorChange(null)}>
            {t("DashboardEarn.setup.all")}
          </FilterButton>
          {curators.map((candidate) => (
            <FilterButton
              key={candidate}
              active={curator === candidate}
              onClick={() => onCuratorChange(candidate)}
            >
              {earnCuratorLabel(candidate)}
            </FilterButton>
          ))}
        </fieldset>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-secondary" role="status" aria-live="polite">
          {selectedIds.length === 0
            ? t("DashboardEarn.setup.noStrategiesSelected")
            : selectedIds.length === 1
              ? t("DashboardEarn.setup.strategySelected")
              : t("DashboardEarn.setup.strategiesSelected", { count: selectedIds.length })}
          {selectedIds.length > 1 ? (
            <span className="text-tertiary">
              {" "}
              ·{" "}
              {shape === "same-curator"
                ? t("DashboardEarn.setup.sameCurator")
                : t("DashboardEarn.setup.mixedCurators")}
            </span>
          ) : null}
        </p>
        {selectedIds.length > 0 ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => onSelectedIdsChange([])}>
            {t("DashboardEarn.setup.clearSelection")}
          </Button>
        ) : null}
      </div>

      {choices.length > 0 ? (
        <div className="grid gap-3 md:grid-cols-2">
          {choices.map((strategy) => {
            const isSelected = selectedIds.includes(strategy.id);
            const disabled =
              !isSelected &&
              !canAddCompatibleStrategy(selectedIds, strategy.id, MOCK_EARN_STRATEGIES);
            return (
              <StrategyCard
                key={strategy.id}
                strategy={strategy}
                selected={isSelected}
                disabled={disabled}
                onToggle={() => toggle(strategy.id)}
              />
            );
          })}
        </div>
      ) : (
        <div className="rounded-2xl border border-dashed border-border-strong px-5 py-10 text-center">
          <p className="text-sm font-medium text-primary">
            {t("DashboardEarn.setup.noResultsTitle")}
          </p>
          <p className="mt-1 text-sm text-tertiary">
            {t("DashboardEarn.setup.noResultsDescription")}
          </p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="mt-4"
            onClick={() => {
              onRiskTierChange(null);
              onSourceChange("all");
              onCuratorChange(null);
            }}
          >
            {t("DashboardEarn.setup.resetFilters")}
          </Button>
        </div>
      )}
    </div>
  );
}

function AllocationRows({
  strategies,
  allocation,
  onChange,
  onEvenSplit,
}: {
  strategies: readonly MockEarnStrategy[];
  allocation: Allocation;
  onChange: (strategyId: string, value: number) => void;
  onEvenSplit: () => void;
}) {
  const t = useTranslations();
  const total = allocationTotal(allocation);
  const allStrategiesWeighted = strategies.every((strategy) => (allocation[strategy.id] ?? 0) > 0);

  return (
    <div className="overflow-hidden rounded-2xl border border-border-default bg-surface-raised">
      <div className="flex items-center justify-between gap-3 border-b border-border-default bg-fill-subtle px-4 py-3">
        <div>
          <p className="text-sm font-medium text-primary">
            {t("DashboardEarn.setup.targetAllocation")}
          </p>
          <p
            id="earn-allocation-status"
            role="status"
            aria-live="polite"
            className={cn(
              "mt-0.5 text-xs",
              total === 100 && allStrategiesWeighted ? "text-success" : "text-warning"
            )}
          >
            {total === 100 && !allStrategiesWeighted
              ? t("DashboardEarn.setup.positiveWeightsRequired")
              : t("DashboardEarn.setup.percentAllocated", { percent: total })}
          </p>
        </div>
        <Button type="button" variant="secondary" size="sm" onClick={onEvenSplit}>
          {t("DashboardEarn.setup.splitEvenly")}
        </Button>
      </div>
      <div className="divide-y divide-border-subtle">
        {strategies.map((strategy) => {
          const inputId = strategy.id;
          return (
            <div
              key={strategy.id}
              className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_8rem] sm:items-center"
            >
              <div className="min-w-0">
                <Label
                  htmlFor={inputId}
                  className="block truncate text-sm font-medium text-primary"
                >
                  {strategy.name}
                </Label>
                <p className="mt-0.5 text-xs text-tertiary">
                  {earnCuratorLabel(strategy.curator)} · {formatApy(strategy.currentApy)}{" "}
                  {t("DashboardEarn.setup.estimatedApyLower")}
                </p>
              </div>
              <div className="relative">
                <Input
                  id={inputId}
                  size="md"
                  type="number"
                  inputMode="numeric"
                  min="0"
                  max="100"
                  value={String(allocation[strategy.id] ?? 0)}
                  aria-label={t("DashboardEarn.setup.allocationPercentageLabel", {
                    strategy: strategy.name,
                  })}
                  aria-describedby="earn-allocation-status"
                  onChange={(event: ChangeEvent<HTMLInputElement>) =>
                    onChange(strategy.id, clampPercentage(Number(event.target.value)))
                  }
                  className="pr-8 text-right [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                />
                <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-tertiary">
                  %
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AllocationStep({
  strategies,
  mode,
  allocation,
  onModeChange,
  onAllocationChange,
  onEvenSplit,
}: {
  strategies: readonly MockEarnStrategy[];
  mode: AllocationMode | null;
  allocation: Allocation;
  onModeChange: (mode: AllocationMode) => void;
  onAllocationChange: (strategyId: string, value: number) => void;
  onEvenSplit: () => void;
}) {
  const t = useTranslations();
  const shape = selectionShape(strategies);
  const curator = strategies[0]?.curator;
  const customRequired = shape === "mixed-curators";
  const effectiveMode = customRequired ? "custom" : mode;

  return (
    <div className="space-y-5">
      {shape === "same-curator" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <ChoiceCard
            selected={mode === "delegate"}
            icon={<SparklesIcon className="size-4" />}
            title={t("DashboardEarn.setup.delegateTitle", {
              curator: earnCuratorLabel(curator ?? ""),
            })}
            description={t("DashboardEarn.setup.delegateDescription")}
            onClick={() => onModeChange("delegate")}
          />
          <ChoiceCard
            selected={mode === "custom"}
            icon={<SlidersHorizontalIcon className="size-4" />}
            title={t("DashboardEarn.setup.customWeightsTitle")}
            description={t("DashboardEarn.setup.customWeightsDescription")}
            onClick={() => onModeChange("custom")}
          />
        </div>
      ) : (
        <div className="flex items-start gap-3 rounded-2xl border border-border-default bg-fill-subtle p-4">
          <SlidersHorizontalIcon className="mt-0.5 size-5 shrink-0 text-secondary" />
          <div>
            <p className="text-sm font-medium text-primary">
              {t("DashboardEarn.setup.mixedRequiresWeights")}
            </p>
            <p className="mt-1 text-[13px] leading-5 text-secondary">
              {t("DashboardEarn.setup.mixedRequiresWeightsDescription")}
            </p>
          </div>
        </div>
      )}

      {effectiveMode === "delegate" ? (
        <div className="rounded-2xl border border-border-default bg-surface-raised p-5">
          <SectionHeading
            icon={<ShieldCheckIcon className="size-4" />}
            title={t("DashboardEarn.setup.delegationSummaryTitle")}
            description={t("DashboardEarn.setup.delegationSummaryDescription", {
              curator: earnCuratorLabel(curator ?? ""),
              count: strategies.length,
            })}
          />
          <div className="mt-4 divide-y divide-border-subtle border-y border-border-subtle">
            {strategies.map((strategy) => (
              <div
                key={strategy.id}
                className="flex items-center justify-between gap-3 py-3 text-sm"
              >
                <span className="text-primary">{strategy.name}</span>
                <span className="text-secondary">{formatApy(strategy.currentApy)}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {effectiveMode === "custom" ? (
        <AllocationRows
          strategies={strategies}
          allocation={allocation}
          onChange={onAllocationChange}
          onEvenSplit={onEvenSplit}
        />
      ) : null}
    </div>
  );
}

function ReviewSection({
  icon,
  title,
  onEdit,
  children,
}: {
  icon: ReactNode;
  title: string;
  onEdit: () => void;
  children: ReactNode;
}) {
  const t = useTranslations();
  return (
    <section className="overflow-hidden rounded-2xl border border-border-default bg-surface-raised">
      <div className="flex items-center justify-between gap-3 border-b border-border-subtle bg-fill-subtle px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="text-secondary">{icon}</span>
          <h3 className="text-sm font-medium text-primary">{title}</h3>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={t("DashboardEarn.setup.editSection", { section: title })}
          onClick={onEdit}
        >
          {t("DashboardEarn.setup.edit")}
        </Button>
      </div>
      <div className="px-4 py-2">{children}</div>
    </section>
  );
}

function ReviewStep({
  wallet,
  destination,
  riskTier,
  source,
  strategies,
  allocationMode,
  allocation,
  onDestinationChange,
  onEdit,
}: {
  wallet: MockEarnWallet | undefined;
  destination: EarnDestination | null;
  riskTier: EarnRiskTier | null;
  source: AssetPreference;
  strategies: readonly MockEarnStrategy[];
  allocationMode: AllocationMode | null;
  allocation: Allocation;
  onDestinationChange: (destination: EarnDestination) => void;
  onEdit: (step: SetupStep) => void;
}) {
  const t = useTranslations();
  const shape = selectionShape(strategies);
  const delegated = shape === "same-curator" && allocationMode === "delegate";
  const effectiveAllocation = strategies.length === 1 ? { [strategies[0].id]: 100 } : allocation;

  return (
    <div className="space-y-4">
      <ReviewSection
        icon={<WalletCardsIcon className="size-4" />}
        title={t("DashboardEarn.setup.reviewWallet")}
        onEdit={() => onEdit("wallet")}
      >
        <SummaryRow label={t("DashboardEarn.setup.wallet")} value={wallet?.name ?? "—"} />
        <SummaryRow
          label={t("DashboardEarn.setup.provider")}
          value={wallet?.providerLabel ?? "—"}
        />
        <SummaryRow label={t("DashboardEarn.setup.network")} value="Solana" />
      </ReviewSection>

      <ReviewSection
        icon={<SlidersHorizontalIcon className="size-4" />}
        title={t("DashboardEarn.setup.reviewPreferences")}
        onEdit={() => onEdit("profile")}
      >
        <SummaryRow
          label={t("DashboardEarn.setup.risk")}
          value={
            riskTier ? t(`DashboardEarn.risk.${riskTier}`) : t("DashboardEarn.setup.noPreference")
          }
        />
        <SummaryRow
          label={t("DashboardEarn.setup.yieldSource")}
          value={
            source === "all"
              ? t("DashboardEarn.setup.noPreference")
              : t(`DashboardEarn.source.${source}`)
          }
        />
      </ReviewSection>

      <ReviewSection
        icon={<Layers3Icon className="size-4" />}
        title={t("DashboardEarn.setup.reviewStrategies")}
        onEdit={() => onEdit("strategy")}
      >
        {strategies.map((strategy) => (
          <SummaryRow
            key={strategy.id}
            label={strategy.name}
            value={
              <span>
                {delegated
                  ? t("DashboardEarn.setup.initialWeight", {
                      percent: effectiveAllocation[strategy.id] ?? 0,
                    })
                  : `${effectiveAllocation[strategy.id] ?? 0}%`}{" "}
                · {formatApy(strategy.currentApy)}
              </span>
            }
          />
        ))}
        {shape === "same-curator" && allocationMode === "delegate" ? (
          <SummaryRow
            label={t("DashboardEarn.setup.allocation")}
            value={t("DashboardEarn.setup.delegatedTo", {
              curator: earnCuratorLabel(strategies[0]?.curator ?? ""),
            })}
          />
        ) : null}
      </ReviewSection>

      <section className="rounded-2xl border border-border-default bg-surface-raised p-4">
        <SectionHeading
          icon={<BriefcaseBusinessIcon className="size-4" />}
          title={t("DashboardEarn.setup.destinationTitle")}
          description={t("DashboardEarn.setup.destinationDescription")}
        />
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <ChoiceCard
            selected={destination === "treasury"}
            icon={<LandmarkIcon className="size-4" />}
            title={t("DashboardEarn.setup.destinationTreasury")}
            description={t("DashboardEarn.setup.destinationTreasuryReview")}
            onClick={() => onDestinationChange("treasury")}
          />
          <ChoiceCard
            selected={destination === "retail"}
            icon={<UsersIcon className="size-4" />}
            title={t("DashboardEarn.setup.destinationRetail")}
            description={t("DashboardEarn.setup.destinationRetailReview")}
            onClick={() => onDestinationChange("retail")}
          />
        </div>
      </section>

      <p className="text-xs leading-5 text-tertiary">
        {t("DashboardEarn.setup.variableRateDisclosure")}
      </p>
    </div>
  );
}

function ProgramSummaryRail({
  wallet,
  destination,
  riskTier,
  strategies,
  allocation,
  ready,
}: {
  wallet: MockEarnWallet | undefined;
  destination: EarnDestination | null;
  riskTier: EarnRiskTier | null;
  strategies: readonly MockEarnStrategy[];
  allocation: Allocation;
  ready: boolean;
}) {
  const t = useTranslations();
  const estimatedApy = weightedApy(strategies, allocation);
  return (
    <aside className="hidden lg:block">
      <div className="sticky top-2 overflow-hidden rounded-2xl border border-border-default bg-surface-raised">
        <div className="border-b border-border-subtle bg-fill-subtle px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium text-primary">
              {t("DashboardEarn.setup.summaryTitle")}
            </h3>
            <Badge variant={ready ? "success" : "default"}>
              {ready ? t("DashboardEarn.setup.ready") : t("DashboardEarn.setup.inProgress")}
            </Badge>
          </div>
        </div>
        <div className="px-4 py-2">
          <SummaryRow label={t("DashboardEarn.setup.wallet")} value={wallet?.name ?? "—"} />
          <SummaryRow
            label={t("DashboardEarn.setup.destination")}
            value={
              destination
                ? destination === "treasury"
                  ? t("DashboardEarn.setup.destinationTreasuryShort")
                  : t("DashboardEarn.setup.destinationRetailShort")
                : "—"
            }
          />
          <SummaryRow
            label={t("DashboardEarn.setup.risk")}
            value={riskTier ? t(`DashboardEarn.risk.${riskTier}`) : "—"}
          />
          <SummaryRow
            label={t("DashboardEarn.setup.strategies")}
            value={strategies.length > 0 ? String(strategies.length) : "—"}
          />
          <SummaryRow
            label={t("DashboardEarn.setup.estimatedApy")}
            value={strategies.length > 0 ? formatApy(String(estimatedApy)) : "—"}
          />
        </div>
      </div>
    </aside>
  );
}

function PostSetupFrame({
  eyebrow,
  title,
  description,
  onBack,
  children,
  footer,
}: {
  eyebrow: string;
  title: string;
  description: string;
  onBack?: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const t = useTranslations();
  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-surface-raised">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 md:px-6" data-earn-post-setup-scroll>
        <div className="mx-auto w-full max-w-5xl py-8">
          <div className="mb-7 flex items-start gap-4">
            {onBack ? (
              <Button
                type="button"
                variant="secondary"
                size="icon-sm"
                onClick={onBack}
                aria-label={t("DashboardEarn.setup.back")}
              >
                <ArrowLeftIcon />
              </Button>
            ) : null}
            <div className="min-w-0">
              <p className="text-xs font-semibold tracking-[0.08em] text-tertiary uppercase">
                {eyebrow}
              </p>
              <h2 className="mt-2 text-2xl font-medium tracking-tight text-primary">{title}</h2>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-secondary">{description}</p>
            </div>
          </div>
          {children}
        </div>
      </div>
      {footer ? (
        <footer className="shrink-0 border-t border-border-default bg-surface-raised/95 px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))] md:px-6">
          <div className="mx-auto w-full max-w-5xl">{footer}</div>
        </footer>
      ) : null}
    </div>
  );
}

function TreasuryFundingScreen({
  wallet,
  strategies,
  allocation,
  delegated,
  tokenMint,
  amountInput,
  submitting,
  onTokenChange,
  onAmountChange,
  onBack,
  onSubmit,
}: {
  wallet: MockEarnWallet;
  strategies: readonly MockEarnStrategy[];
  allocation: Allocation;
  delegated: boolean;
  tokenMint: string;
  amountInput: string;
  submitting: boolean;
  onTokenChange: (mint: string) => void;
  onAmountChange: (value: string) => void;
  onBack: () => void;
  onSubmit: () => void;
}) {
  const t = useTranslations();
  const eligibleMints = commonDepositMints(strategies);
  const amount = Number(amountInput);
  const balance = wallet.balances[tokenMint] ?? 0;
  const amountEntered = amountInput.trim().length > 0;
  const amountPositive = Number.isFinite(amount) && amount >= 0.01;
  const amountValid = amountEntered && amountPositive && amount <= balance;
  const legs = buildLegs(strategies, allocation, amountValid ? amount : 0);
  const projectedYield = legs.reduce(
    (sum, leg) => sum + projectYearlyYield(leg.legAmount, leg.strategy.currentApy),
    0
  );

  return (
    <PostSetupFrame
      eyebrow={t("DashboardEarn.setup.treasuryEyebrow")}
      title={t("DashboardEarn.setup.fundVaultTitle")}
      description={t(
        delegated
          ? "DashboardEarn.setup.fundVaultDelegatedDescription"
          : "DashboardEarn.setup.fundVaultDescription"
      )}
      onBack={onBack}
      footer={
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between [&>button]:w-full sm:[&>button]:w-auto">
          <Button type="button" variant="secondary" disabled={submitting} onClick={onBack}>
            {t("DashboardEarn.setup.backToReview")}
          </Button>
          <Button
            type="button"
            disabled={!amountValid || submitting}
            onClick={onSubmit}
            iconLeft={
              submitting ? (
                <Loader2Icon className="animate-spin motion-reduce:animate-none" />
              ) : undefined
            }
          >
            {submitting
              ? t("DashboardEarn.setup.depositing")
              : t("DashboardEarn.setup.depositIntoVault")}
          </Button>
        </div>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section className="rounded-2xl border border-border-default bg-surface-raised p-5">
          <SectionHeading
            icon={<BanknoteIcon className="size-4" />}
            title={t("DashboardEarn.setup.depositDetails")}
            description={t("DashboardEarn.setup.depositDetailsDescription")}
          />

          <div className="mt-5 space-y-5">
            <div className="rounded-xl border border-border-default bg-fill-subtle px-4 py-3">
              <p className="text-xs text-tertiary">{t("DashboardEarn.setup.fundingFrom")}</p>
              <div className="mt-2 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-primary">{wallet.name}</p>
                  <p className="mt-0.5 truncate text-xs text-secondary">
                    {wallet.providerLabel} · {shortenAddress(wallet.address)}
                  </p>
                </div>
                <CheckCircle2Icon className="size-5 shrink-0 text-success" />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>{t("DashboardEarn.setup.asset")}</Label>
                <Select
                  ariaLabel={t("DashboardEarn.setup.asset")}
                  size="xl"
                  className="w-full"
                  disabled={submitting}
                  value={tokenMint}
                  onValueChange={(value) => onTokenChange(value ?? "")}
                  iconLeft={<BanknoteIcon />}
                >
                  {eligibleMints.map((mint) => (
                    <SelectItem key={mint} value={mint}>
                      {tokenSymbol(mint)}
                    </SelectItem>
                  ))}
                </Select>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="earn-deposit-amount">{t("DashboardEarn.setup.amount")}</Label>
                  <button
                    type="button"
                    disabled={submitting}
                    className="text-xs font-medium text-primary focus-visible:outline-none focus-visible:underline disabled:cursor-not-allowed disabled:opacity-40"
                    onClick={() => onAmountChange(String(balance))}
                  >
                    {t("DashboardEarn.setup.useMax")}
                  </button>
                </div>
                <Input
                  id="earn-deposit-amount"
                  size="xl"
                  type="number"
                  min="0.01"
                  step="0.01"
                  inputMode="decimal"
                  placeholder="0.00"
                  disabled={submitting}
                  value={amountInput}
                  aria-invalid={amountEntered && !amountValid}
                  aria-describedby={
                    amountEntered && !amountValid
                      ? "earn-deposit-balance earn-deposit-error"
                      : "earn-deposit-balance"
                  }
                  onChange={(event: ChangeEvent<HTMLInputElement>) =>
                    onAmountChange(event.target.value)
                  }
                />
                <p id="earn-deposit-balance" className="text-xs text-tertiary">
                  {t("DashboardEarn.setup.balanceAvailable", {
                    balance: formatTokenAmount(balance, tokenMint),
                  })}
                </p>
                {amountEntered && !amountPositive ? (
                  <p id="earn-deposit-error" className="text-xs text-error">
                    {t("DashboardEarn.setup.invalidAmount")}
                  </p>
                ) : amountEntered && amount > balance ? (
                  <p id="earn-deposit-error" className="text-xs text-error">
                    {t("DashboardEarn.setup.insufficientBalance")}
                  </p>
                ) : null}
              </div>
            </div>
          </div>
        </section>

        <aside className="h-fit overflow-hidden rounded-2xl border border-border-default bg-surface-raised">
          <div className="border-b border-border-subtle bg-fill-subtle px-4 py-3">
            <h3 className="text-sm font-medium text-primary">
              {t("DashboardEarn.setup.depositPreview")}
            </h3>
          </div>
          <div className="px-4 py-2">
            {legs.map((leg) => (
              <SummaryRow
                key={leg.strategy.id}
                label={`${leg.strategy.name} · ${leg.pct}%`}
                value={formatTokenAmount(leg.legAmount, tokenMint)}
              />
            ))}
            <SummaryRow
              label={t("DashboardEarn.setup.projectedYearlyYield")}
              value={amountValid ? formatUsd(projectedYield) : "—"}
            />
            <SummaryRow
              label={t("DashboardEarn.setup.networkFee")}
              value={t("DashboardEarn.setup.sponsored")}
            />
          </div>
          <p className="border-t border-border-subtle px-4 py-3 text-xs leading-5 text-tertiary">
            {t("DashboardEarn.setup.depositMockNotice")}
          </p>
        </aside>
      </div>
    </PostSetupFrame>
  );
}

function RetailPreviewScreen({
  strategies,
  allocation,
  tokenMint,
  delegated,
  onBack,
  onContinue,
}: {
  strategies: readonly MockEarnStrategy[];
  allocation: Allocation;
  tokenMint: string;
  delegated: boolean;
  onBack: () => void;
  onContinue: () => void;
}) {
  const t = useTranslations();
  const estimatedApy = weightedApy(strategies, allocation);
  return (
    <PostSetupFrame
      eyebrow={t("DashboardEarn.setup.retailEyebrow")}
      title={t("DashboardEarn.setup.previewTitle")}
      description={t("DashboardEarn.setup.previewDescription")}
      onBack={onBack}
      footer={
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between [&>button]:w-full sm:[&>button]:w-auto">
          <Button type="button" variant="secondary" onClick={onBack}>
            {t("DashboardEarn.setup.backToReview")}
          </Button>
          <Button type="button" onClick={onContinue} iconRight={<ArrowRightIcon />}>
            {t("DashboardEarn.setup.continueToIntegration")}
          </Button>
        </div>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <aside className="h-fit overflow-hidden rounded-2xl border border-border-default bg-surface-raised">
          <div className="border-b border-border-subtle bg-fill-subtle px-4 py-3">
            <h3 className="text-sm font-medium text-primary">
              {t("DashboardEarn.setup.experienceSummary")}
            </h3>
          </div>
          <div className="px-4 py-2">
            <SummaryRow
              label={t("DashboardEarn.setup.strategies")}
              value={String(strategies.length)}
            />
            <SummaryRow
              label={t("DashboardEarn.setup.estimatedApy")}
              value={formatApy(String(estimatedApy))}
            />
            <SummaryRow label={t("DashboardEarn.setup.asset")} value={tokenSymbol(tokenMint)} />
            <SummaryRow
              label={t("DashboardEarn.setup.environment")}
              value={t("DashboardEarn.setup.sandbox")}
            />
          </div>
          <p className="border-t border-border-subtle px-4 py-3 text-xs leading-5 text-tertiary">
            {t("DashboardEarn.setup.previewOnlyNotice")}
          </p>
        </aside>

        <section className="overflow-hidden rounded-2xl border border-border-default bg-fill-subtle p-3 sm:p-5">
          <div className="overflow-hidden rounded-xl border border-border-default bg-surface-raised shadow-sm">
            <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-4 py-3">
              <div className="flex items-center gap-2.5">
                <span className="flex size-7 items-center justify-center rounded-lg bg-primary text-xs font-semibold text-on-primary">
                  A
                </span>
                <span className="text-sm font-medium text-primary">
                  {t("DashboardEarn.setup.previewBrand")}
                </span>
                <span className="text-xs text-tertiary">/ {t("DashboardEarn.setup.earn")}</span>
              </div>
              <Badge variant="info">{t("DashboardEarn.setup.previewBadge")}</Badge>
            </div>
            <div className="p-4 sm:p-6">
              <p className="text-xs font-medium text-tertiary">
                {t("DashboardEarn.setup.earnBalance")}
              </p>
              <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="text-3xl font-medium tracking-tight text-primary">$12,480.00</p>
                  <p className="mt-1 text-sm text-success">
                    +$42.18 {t("DashboardEarn.setup.thisMonth")}
                  </p>
                </div>
                <p className="text-right text-sm text-secondary">
                  <span className="block text-lg font-medium text-primary">
                    {formatApy(String(estimatedApy))}
                  </span>
                  {t("DashboardEarn.setup.estimatedApy")}
                </p>
              </div>

              <div className="mt-6 grid gap-3 sm:grid-cols-2">
                {strategies.map((strategy) => (
                  <div key={strategy.id} className="rounded-xl border border-border-default p-3.5">
                    <p className="text-sm font-medium text-primary">{strategy.name}</p>
                    <p className="mt-1 text-xs text-tertiary">
                      {earnCuratorLabel(strategy.curator)}
                    </p>
                    <div className="mt-4 flex items-end justify-between gap-2">
                      <span className="text-lg font-medium text-primary">
                        {formatApy(strategy.currentApy)}
                      </span>
                      <span className="text-xs text-secondary">
                        {delegated
                          ? t("DashboardEarn.setup.initialWeight", {
                              percent: allocation[strategy.id] ?? 0,
                            })
                          : `${allocation[strategy.id] ?? 0}%`}
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              <Button type="button" disabled className="mt-5 w-full">
                {t("DashboardEarn.setup.previewOnlyCta")}
              </Button>
            </div>
          </div>
        </section>
      </div>
    </PostSetupFrame>
  );
}

function RetailIntegrationScreen({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const t = useTranslations();
  const [tab, setTab] = useState<IntegrationTab>(INTEGRATION_TABS.sdk);
  const [copied, setCopied] = useState(false);
  const snippet = tab === INTEGRATION_TABS.sdk ? SDK_SNIPPET : API_SNIPPET;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  return (
    <PostSetupFrame
      eyebrow={t("DashboardEarn.setup.retailEyebrow")}
      title={t("DashboardEarn.setup.integrateTitle")}
      description={t("DashboardEarn.setup.integrateDescription")}
      onBack={onBack}
      footer={
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between [&>button]:w-full sm:[&>button]:w-auto">
          <Button type="button" variant="secondary" onClick={onBack}>
            {t("DashboardEarn.setup.backToPreview")}
          </Button>
          <Button type="button" onClick={onDone} iconRight={<ArrowRightIcon />}>
            {t("DashboardEarn.setup.done")}
          </Button>
        </div>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <section className="overflow-hidden rounded-2xl border border-border-default bg-surface-raised">
          <div className="flex flex-col gap-3 border-b border-border-default bg-fill-subtle px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="inline-flex rounded-lg border border-border-default bg-surface-raised p-0.5">
              {Object.values(INTEGRATION_TABS).map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  aria-pressed={tab === candidate}
                  onClick={() => setTab(candidate)}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                    tab === candidate ? "bg-fill text-primary" : "text-secondary hover:text-primary"
                  )}
                >
                  {candidate === INTEGRATION_TABS.sdk
                    ? t("DashboardEarn.setup.sdkTab")
                    : t("DashboardEarn.setup.apiTab")}
                </button>
              ))}
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              iconLeft={copied ? <CheckIcon /> : <CopyIcon />}
              onClick={copy}
            >
              {copied ? t("DashboardEarn.setup.copied") : t("DashboardEarn.setup.copy")}
            </Button>
          </div>
          <pre className="min-h-80 overflow-x-auto bg-[#171719] p-5 text-[13px] leading-6 text-[#f5f5f2]">
            <code>{snippet}</code>
          </pre>
        </section>

        <aside className="h-fit space-y-4">
          <section className="overflow-hidden rounded-2xl border border-border-default bg-surface-raised">
            <div className="border-b border-border-subtle bg-fill-subtle px-4 py-3">
              <h3 className="text-sm font-medium text-primary">
                {t("DashboardEarn.setup.configuration")}
              </h3>
            </div>
            <div className="px-4 py-2">
              <SummaryRow
                label={t("DashboardEarn.setup.environment")}
                value={<Badge variant="success">{t("DashboardEarn.setup.sandboxReady")}</Badge>}
              />
              <SummaryRow
                label={t("DashboardEarn.setup.configurationId")}
                value="earn_config_sandbox_01"
              />
              <SummaryRow label={t("DashboardEarn.setup.network")} value="Solana Devnet" />
            </div>
          </section>
          <section className="rounded-2xl border border-border-default bg-surface-raised p-4">
            <h3 className="text-sm font-medium text-primary">
              {t("DashboardEarn.setup.integrationChecklist")}
            </h3>
            <ul className="mt-3 space-y-3">
              {INTEGRATION_CHECKLIST.map((item) => (
                <li
                  key={item}
                  className="flex items-start gap-2.5 text-[13px] leading-5 text-secondary"
                >
                  <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-success" />
                  {t(item)}
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </PostSetupFrame>
  );
}

function VaultLiveScreen({
  strategies,
  allocation,
  amount,
  tokenMint,
  delegated,
  onAnother,
  onDashboard,
}: {
  strategies: readonly MockEarnStrategy[];
  allocation: Allocation;
  amount: number;
  tokenMint: string;
  delegated: boolean;
  onAnother: () => void;
  onDashboard: () => void;
}) {
  const t = useTranslations();
  const estimatedApy = weightedApy(strategies, allocation);
  const projectedYield = strategies.reduce(
    (sum, strategy) =>
      sum +
      projectYearlyYield(amount * ((allocation[strategy.id] ?? 0) / 100), strategy.currentApy),
    0
  );

  return (
    <PostSetupFrame
      eyebrow={t("DashboardEarn.setup.vaultDashboardEyebrow")}
      title={t("DashboardEarn.setup.vaultLiveTitle")}
      description={t("DashboardEarn.setup.vaultLiveDescription")}
      footer={
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between [&>button]:w-full sm:[&>button]:w-auto">
          <Button type="button" variant="secondary" onClick={onAnother}>
            {t("DashboardEarn.setup.depositMore")}
          </Button>
          <Button type="button" onClick={onDashboard}>
            {t("DashboardEarn.setup.viewEarnDashboard")}
          </Button>
        </div>
      }
    >
      <div className="flex items-start gap-3 rounded-2xl border border-success-border bg-success-bg p-4 text-success">
        <CheckCircle2Icon className="size-5 shrink-0" />
        <div>
          <p className="text-sm font-medium">{t("DashboardEarn.setup.depositConfirmed")}</p>
          <p className="mt-1 text-[13px] leading-5">
            {t("DashboardEarn.setup.depositConfirmedDescription")}
          </p>
        </div>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        {[
          {
            label: t("DashboardEarn.setup.totalValue"),
            value: formatTokenAmount(amount, tokenMint),
          },
          { label: t("DashboardEarn.setup.estimatedApy"), value: formatApy(String(estimatedApy)) },
          {
            label: t("DashboardEarn.setup.projectedYearlyYield"),
            value: formatUsd(projectedYield),
          },
        ].map((stat) => (
          <div
            key={stat.label}
            className="rounded-2xl border border-border-default bg-surface-raised p-4"
          >
            <p className="text-xs text-tertiary">{stat.label}</p>
            <p className="mt-2 text-xl font-medium tracking-tight text-primary">{stat.value}</p>
          </div>
        ))}
      </div>

      <section className="mt-5 overflow-hidden rounded-2xl border border-border-default bg-surface-raised">
        <div className="border-b border-border-default bg-fill-subtle px-4 py-3">
          <h3 className="text-sm font-medium text-primary">
            {t("DashboardEarn.setup.strategyAllocation")}
          </h3>
        </div>
        <div className="divide-y divide-border-subtle">
          {strategies.map((strategy) => (
            <div
              key={strategy.id}
              className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_8rem_8rem] sm:items-center"
            >
              <div>
                <p className="text-sm text-primary">{strategy.name}</p>
                <p className="mt-0.5 text-xs text-tertiary">{earnCuratorLabel(strategy.curator)}</p>
              </div>
              <p className="text-sm text-secondary sm:text-right">
                {delegated
                  ? t("DashboardEarn.setup.initialWeight", {
                      percent: allocation[strategy.id] ?? 0,
                    })
                  : `${allocation[strategy.id] ?? 0}%`}
              </p>
              <p className="text-sm text-primary sm:text-right">
                {formatTokenAmount(amount * ((allocation[strategy.id] ?? 0) / 100), tokenMint)}
              </p>
            </div>
          ))}
        </div>
      </section>
    </PostSetupFrame>
  );
}

interface EarnDepositWizardProps {
  initialStrategyId?: string;
}

interface SetupReadinessInput {
  wallet: MockEarnWallet | undefined;
  strategies: readonly MockEarnStrategy[];
  shape: ReturnType<typeof selectionShape>;
  allocationMode: AllocationMode | null;
  allocation: Allocation;
  destination: EarnDestination | null;
}

function getSetupReadiness({
  wallet,
  strategies,
  shape,
  allocationMode,
  allocation,
  destination,
}: SetupReadinessInput): Record<SetupStep, boolean> {
  const total = allocationTotal(allocation);
  const weightsReady =
    total === 100 && strategies.every((strategy) => (allocation[strategy.id] ?? 0) > 0);
  const allocationReady =
    strategies.length > 1 &&
    (shape === "mixed-curators"
      ? weightsReady
      : allocationMode === "delegate" || (allocationMode === "custom" && weightsReady));

  const programReady =
    Boolean(wallet) &&
    strategies.length > 0 &&
    Boolean(destination) &&
    (strategies.length === 1 || allocationReady);

  return {
    wallet: Boolean(wallet),
    profile: true,
    strategy: strategies.length > 0,
    allocation: allocationReady,
    review: programReady,
  };
}

function nextSetupStep(step: SetupStep, strategyCount: number): SetupStep | null {
  if (step === "wallet") return "profile";
  if (step === "profile") return "strategy";
  if (step === "strategy") return strategyCount > 1 ? "allocation" : "review";
  if (step === "allocation") return "review";
  return null;
}

function previousSetupStep(step: SetupStep, strategyCount: number): SetupStep | null {
  if (step === "profile") return "wallet";
  if (step === "strategy") return "profile";
  if (step === "allocation") return "strategy";
  if (step === "review") return strategyCount > 1 ? "allocation" : "strategy";
  return null;
}

function setupProgressIndex(step: SetupStep): number {
  if (step === "allocation") return 2;
  return SETUP_PROGRESS.indexOf(step);
}

function primaryActionLabel(
  step: SetupStep,
  destination: EarnDestination | null,
  strategyCount: number,
  editingFromReview: boolean,
  t: ReturnType<typeof useTranslations>
): string {
  if (step === "strategy" && strategyCount === 0) {
    return t("DashboardEarn.setup.selectStrategy");
  }
  if (editingFromReview && (step !== "strategy" || strategyCount <= 1)) {
    return t("DashboardEarn.setup.saveChanges");
  }
  if (step === "wallet") return t("DashboardEarn.setup.importWallet");
  if (step === "profile") return t("DashboardEarn.setup.showStrategies");
  if (step === "strategy") {
    return strategyCount === 1
      ? t("DashboardEarn.setup.continueWithStrategy")
      : t("DashboardEarn.setup.continueWithStrategies", { count: strategyCount });
  }
  if (step === "allocation") return t("DashboardEarn.setup.reviewSetup");
  if (destination === null) return t("DashboardEarn.setup.chooseDestination");
  return destination === "retail"
    ? t("DashboardEarn.setup.createEarnExperience")
    : t("DashboardEarn.setup.createVault");
}

interface PostSetupContentProps {
  screen: PostSetupScreen;
  wallet: MockEarnWallet | undefined;
  strategies: readonly MockEarnStrategy[];
  allocation: Allocation;
  allocationMode: AllocationMode | null;
  tokenMint: string;
  amountInput: string;
  submitting: boolean;
  onTokenChange: (mint: string) => void;
  onAmountChange: (value: string) => void;
  onScreenChange: (screen: PostSetupScreen | null) => void;
  onSubmitDeposit: () => void;
  onDashboard: () => void;
}

function PostSetupContent({
  screen,
  wallet,
  strategies,
  allocation,
  allocationMode,
  tokenMint,
  amountInput,
  submitting,
  onTokenChange,
  onAmountChange,
  onScreenChange,
  onSubmitDeposit,
  onDashboard,
}: PostSetupContentProps) {
  if (screen === "treasury" && wallet) {
    return (
      <TreasuryFundingScreen
        wallet={wallet}
        strategies={strategies}
        allocation={allocation}
        delegated={allocationMode === "delegate"}
        tokenMint={tokenMint}
        amountInput={amountInput}
        submitting={submitting}
        onTokenChange={onTokenChange}
        onAmountChange={onAmountChange}
        onBack={() => onScreenChange(null)}
        onSubmit={onSubmitDeposit}
      />
    );
  }
  if (screen === "retail-preview") {
    return (
      <RetailPreviewScreen
        strategies={strategies}
        allocation={allocation}
        tokenMint={tokenMint}
        delegated={allocationMode === "delegate"}
        onBack={() => onScreenChange(null)}
        onContinue={() => onScreenChange("retail-integration")}
      />
    );
  }
  if (screen === "retail-integration") {
    return (
      <RetailIntegrationScreen
        onBack={() => onScreenChange("retail-preview")}
        onDone={onDashboard}
      />
    );
  }
  if (screen === "vault-live") {
    return (
      <VaultLiveScreen
        strategies={strategies}
        allocation={allocation}
        amount={Number(amountInput)}
        tokenMint={tokenMint}
        delegated={allocationMode === "delegate"}
        onAnother={() => {
          onAmountChange("");
          onScreenChange("treasury");
        }}
        onDashboard={onDashboard}
      />
    );
  }
  return null;
}

interface SetupStepContentProps {
  step: SetupStep;
  provider: WalletProvider | null;
  walletId: string;
  destination: EarnDestination | null;
  riskTier: EarnRiskTier | null;
  source: AssetPreference;
  curatorFilter: string | null;
  strategyIds: readonly string[];
  strategies: readonly MockEarnStrategy[];
  allocationMode: AllocationMode | null;
  allocation: Allocation;
  onProviderChange: (provider: WalletProvider) => void;
  onWalletChange: (walletId: string) => void;
  onDestinationChange: (destination: EarnDestination | null) => void;
  onRiskTierChange: (riskTier: EarnRiskTier | null) => void;
  onSourceChange: (source: AssetPreference) => void;
  onCuratorChange: (curator: string | null) => void;
  onStrategiesChange: (ids: string[]) => void;
  onAllocationModeChange: (mode: AllocationMode) => void;
  onAllocationChange: (strategyId: string, value: number) => void;
  onEvenSplit: () => void;
  onBrowseAll: () => void;
  onEdit: (step: SetupStep) => void;
}

function SetupStepContent(props: SetupStepContentProps) {
  if (props.step === "wallet") {
    return (
      <WalletStep
        provider={props.provider}
        walletId={props.walletId}
        onProviderChange={props.onProviderChange}
        onWalletChange={props.onWalletChange}
      />
    );
  }
  if (props.step === "profile") {
    return (
      <QuestionnaireStep
        destination={props.destination}
        riskTier={props.riskTier}
        source={props.source}
        onDestinationChange={props.onDestinationChange}
        onRiskTierChange={props.onRiskTierChange}
        onSourceChange={props.onSourceChange}
        onBrowseAll={props.onBrowseAll}
      />
    );
  }
  if (props.step === "strategy") {
    return (
      <StrategyStep
        selectedIds={props.strategyIds}
        riskTier={props.riskTier}
        source={props.source}
        curator={props.curatorFilter}
        onSelectedIdsChange={props.onStrategiesChange}
        onRiskTierChange={props.onRiskTierChange}
        onSourceChange={props.onSourceChange}
        onCuratorChange={props.onCuratorChange}
      />
    );
  }
  if (props.step === "allocation") {
    return (
      <AllocationStep
        strategies={props.strategies}
        mode={props.allocationMode}
        allocation={props.allocation}
        onModeChange={props.onAllocationModeChange}
        onAllocationChange={props.onAllocationChange}
        onEvenSplit={props.onEvenSplit}
      />
    );
  }
  return (
    <ReviewStep
      wallet={MOCK_EARN_WALLETS.find((candidate) => candidate.id === props.walletId)}
      destination={props.destination}
      riskTier={props.riskTier}
      source={props.source}
      strategies={props.strategies}
      allocationMode={props.allocationMode}
      allocation={props.allocation}
      onDestinationChange={(next) => props.onDestinationChange(next)}
      onEdit={props.onEdit}
    />
  );
}

export function EarnDepositWizard({ initialStrategyId }: EarnDepositWizardProps) {
  const t = useTranslations();
  const router = useDashboardRouter();
  const reduceMotion = useReducedMotion();
  const initialStrategy = MOCK_EARN_STRATEGIES.find(
    (strategy) => strategy.id === initialStrategyId
  );

  const [step, setStep] = useState<SetupStep>("wallet");
  const [editingFromReview, setEditingFromReview] = useState(false);
  const [direction, setDirection] = useState(1);
  const [postSetupScreen, setPostSetupScreen] = useState<PostSetupScreen | null>(null);
  const [provider, setProvider] = useState<WalletProvider | null>(null);
  const [walletId, setWalletId] = useState("");
  const [destination, setDestination] = useState<EarnDestination | null>(null);
  const [riskTier, setRiskTier] = useState<EarnRiskTier | null>(initialStrategy?.riskTier ?? null);
  const [source, setSource] = useState<AssetPreference>(initialStrategy?.sourceKind ?? "all");
  const [curatorFilter, setCuratorFilter] = useState<string | null>(null);
  const [strategyIds, setStrategyIds] = useState<string[]>(
    initialStrategy ? [initialStrategy.id] : []
  );
  const [allocationMode, setAllocationMode] = useState<AllocationMode | null>(null);
  const [allocation, setAllocation] = useState<Allocation>(
    initialStrategy ? { [initialStrategy.id]: 100 } : {}
  );
  const [tokenMint, setTokenMint] = useState(
    initialStrategy?.depositMints[0] ?? DEFAULT_DEPOSIT_MINT
  );
  const [amountInput, setAmountInput] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const wallet = MOCK_EARN_WALLETS.find((candidate) => candidate.id === walletId);
  const strategies = selectedStrategies(strategyIds, MOCK_EARN_STRATEGIES);
  const shape = selectionShape(strategies);
  const effectiveAllocation = useMemo(() => {
    if (strategies.length === 1) return { [strategies[0].id]: 100 };
    if (allocationMode === "delegate") return evenAllocation(strategyIds);
    return allocation;
  }, [allocation, allocationMode, strategies, strategyIds]);

  const progressStep = setupProgressIndex(step);
  const stepReady = getSetupReadiness({
    wallet,
    strategies,
    shape,
    allocationMode,
    allocation,
    destination,
  });

  const chooseProvider = (nextProvider: WalletProvider) => {
    setProvider(nextProvider);
    const firstWallet = MOCK_EARN_WALLETS.find((candidate) => candidate.provider === nextProvider);
    setWalletId(firstWallet?.id ?? "");
  };

  const updateStrategies = (ids: string[]) => {
    setStrategyIds(ids);
    setAllocation(evenAllocation(ids));
    setAllocationMode(null);
    const selected = selectedStrategies(ids, MOCK_EARN_STRATEGIES);
    const mints = commonDepositMints(selected);
    if (!mints.includes(tokenMint)) {
      setTokenMint(mints[0] ?? DEFAULT_DEPOSIT_MINT);
    }
  };

  const moveTo = (nextStep: SetupStep, nextDirection: number) => {
    setDirection(nextDirection);
    setStep(nextStep);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: Every wizard step transition should reset scroll and announce its active heading.
  useEffect(() => {
    const scrollRegion = document.querySelector<HTMLElement>(
      postSetupScreen ? "[data-earn-post-setup-scroll]" : "[data-payments-wizard-scroll-region]"
    );
    if (!scrollRegion) return;

    scrollRegion.scrollTop = 0;
    const heading = scrollRegion.querySelector<HTMLHeadingElement>("h2");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  }, [step, postSetupScreen]);

  const goNext = () => {
    if (!stepReady[step]) return;
    if (editingFromReview) {
      if (step === "strategy" && strategies.length > 1) {
        moveTo("allocation", 1);
        return;
      }
      setEditingFromReview(false);
      moveTo("review", 1);
      return;
    }
    const nextStep = nextSetupStep(step, strategies.length);
    if (nextStep) {
      moveTo(nextStep, 1);
      return;
    }
    if (destination) {
      setPostSetupScreen(destination === "treasury" ? "treasury" : "retail-preview");
    }
  };

  const goBack = () => {
    if (editingFromReview) {
      setEditingFromReview(false);
      moveTo("review", 1);
      return;
    }
    const previousStep = previousSetupStep(step, strategies.length);
    if (!previousStep) {
      router.push("/dashboard/markets/earn");
      return;
    }
    moveTo(previousStep, -1);
  };

  const submitDeposit = () => {
    if (!wallet || strategies.length === 0 || submitting) return;
    const amount = Number(amountInput);
    const balance = wallet.balances[tokenMint] ?? 0;
    if (!Number.isFinite(amount) || amount <= 0 || amount > balance) return;
    setSubmitting(true);
    window.setTimeout(() => {
      for (const strategy of strategies) {
        addMockPosition({
          strategyId: strategy.id,
          walletId: wallet.id,
          tokenMint,
          amount: amount * ((effectiveAllocation[strategy.id] ?? 0) / 100),
        });
      }
      setSubmitting(false);
      setPostSetupScreen("vault-live");
    }, 650);
  };

  if (postSetupScreen) {
    return (
      <PostSetupContent
        screen={postSetupScreen}
        wallet={wallet}
        strategies={strategies}
        allocation={effectiveAllocation}
        allocationMode={allocationMode}
        tokenMint={tokenMint}
        amountInput={amountInput}
        submitting={submitting}
        onTokenChange={setTokenMint}
        onAmountChange={setAmountInput}
        onScreenChange={setPostSetupScreen}
        onSubmitDeposit={submitDeposit}
        onDashboard={() => router.push("/dashboard/markets/earn")}
      />
    );
  }

  const activeMeta = stepMeta[step];
  const showSummaryRail = step !== "wallet" && step !== "strategy";
  const primaryLabel = primaryActionLabel(
    step,
    destination,
    strategies.length,
    editingFromReview,
    t
  );

  return (
    <PaymentsWizardFrame
      steps={SETUP_PROGRESS.map((progress) => ({
        label: t(`DashboardEarn.setup.progress.${progress}` as MessageKey),
        title: t(
          progress === "strategy" && step === "allocation"
            ? stepMeta.allocation.title
            : stepMeta[progress].title
        ),
      }))}
      currentStep={progressStep}
      progressLabel={t("DashboardEarn.setup.stepProgress", {
        current: progressStep + 1,
        total: SETUP_PROGRESS.length,
      })}
      description={t(activeMeta.description)}
      maxWidthClassName={step === "strategy" ? "max-w-5xl" : "max-w-4xl"}
      footer={
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between [&>button]:w-full sm:[&>button]:w-auto">
          <Button
            type="button"
            variant="secondary"
            onClick={goBack}
            iconLeft={step === "wallet" && !editingFromReview ? undefined : <ArrowLeftIcon />}
          >
            {editingFromReview
              ? t("DashboardEarn.setup.backToReview")
              : step === "wallet"
                ? t("DashboardEarn.setup.cancel")
                : t("DashboardEarn.setup.back")}
          </Button>
          <Button
            type="button"
            disabled={!stepReady[step]}
            onClick={goNext}
            iconRight={<ArrowRightIcon />}
          >
            {primaryLabel}
          </Button>
        </div>
      }
    >
      <div className={cn("grid gap-6", showSummaryRail && "lg:grid-cols-[minmax(0,1fr)_17rem]")}>
        <div className="relative min-h-[22rem] overflow-hidden">
          <AnimatePresence mode="wait" custom={direction} initial={false}>
            <motion.div
              key={step}
              custom={direction}
              initial={reduceMotion ? false : { opacity: 0, x: direction * 8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: direction * -8 }}
              transition={{ duration: reduceMotion ? 0 : 0.18, ease: "easeOut" }}
              className="px-0.5 py-0.5"
            >
              <SetupStepContent
                step={step}
                provider={provider}
                walletId={walletId}
                destination={destination}
                riskTier={riskTier}
                source={source}
                curatorFilter={curatorFilter}
                strategyIds={strategyIds}
                strategies={strategies}
                allocationMode={allocationMode}
                allocation={effectiveAllocation}
                onProviderChange={chooseProvider}
                onWalletChange={setWalletId}
                onDestinationChange={setDestination}
                onRiskTierChange={setRiskTier}
                onSourceChange={setSource}
                onCuratorChange={setCuratorFilter}
                onStrategiesChange={updateStrategies}
                onAllocationModeChange={setAllocationMode}
                onAllocationChange={(strategyId, value) =>
                  setAllocation((current) => ({ ...current, [strategyId]: value }))
                }
                onEvenSplit={() => setAllocation(evenAllocation(strategyIds))}
                onBrowseAll={() => {
                  setDestination(null);
                  setRiskTier(null);
                  setSource("all");
                  setCuratorFilter(null);
                  moveTo("strategy", 1);
                }}
                onEdit={(target) => {
                  setEditingFromReview(true);
                  moveTo(target, -1);
                }}
              />
            </motion.div>
          </AnimatePresence>
        </div>

        {showSummaryRail ? (
          <ProgramSummaryRail
            wallet={wallet}
            destination={destination}
            riskTier={riskTier}
            strategies={strategies}
            allocation={effectiveAllocation}
            ready={stepReady.review}
          />
        ) : null}
      </div>
    </PaymentsWizardFrame>
  );
}
