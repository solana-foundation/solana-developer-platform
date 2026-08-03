"use client";

import { earnCuratorLabel } from "@sdp/types";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BanknoteIcon,
  BriefcaseBusinessIcon,
  CheckCircle2Icon,
  CheckIcon,
  ChevronDownIcon,
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
import { type ChangeEvent, type ReactNode, useId, useLayoutEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectItem } from "@/components/ui/select";
import { WizardFrame } from "@/components/wizard-frame";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { useDashboardRouter } from "@/lib/use-dashboard-router";
import { cn } from "@/lib/utils";
import {
  DEFAULT_DEPOSIT_MINT,
  EARN_RISK_TIERS,
  type EarnRiskTier,
  formatApy,
  formatTokenAmount,
  formatUsd,
  MOCK_EARN_STRATEGIES,
  MOCK_EARN_WALLETS,
  type MockEarnStrategy,
  type MockEarnWallet,
  projectYearlyYield,
  tokenSymbol,
} from "../earn-mock-data";
import { addMockPosition } from "../earn-mock-positions";
import {
  CURATOR_PROGRAMS,
  curatorApyRange,
  curatorMonogram,
  curatorProfileKey,
  useLiquidityLabel,
} from "../earn-program-presentation";
import {
  type AssetPreference,
  buildCuratorFundingPlan,
  type CuratorProgram,
  curatorMatchesPreferences,
  type EarnDestination,
  type StrategyAllocation,
  weightedApy,
} from "./earn-setup-model";

type SetupStep = "wallet" | "profile" | "curator" | "review";
type PostSetupScreen = "treasury" | "retail-preview" | "retail-integration" | "vault-live";
type WalletProvider = MockEarnWallet["provider"];
type Allocation = StrategyAllocation;

interface DepositLeg {
  strategy: MockEarnStrategy;
  pct: number;
  legAmount: number;
}

const SETUP_PROGRESS = ["wallet", "profile", "curator", "review"] as const;

const stepMeta: Record<SetupStep, { title: MessageKey; description: MessageKey }> = {
  wallet: {
    title: "DashboardEarn.setup.walletTitle",
    description: "DashboardEarn.setup.walletDescription",
  },
  profile: {
    title: "DashboardEarn.setup.preferencesTitle",
    description: "DashboardEarn.setup.preferencesDescription",
  },
  curator: {
    title: "DashboardEarn.setup.curatorsTitle",
    description: "DashboardEarn.setup.curatorsDescription",
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
  const [showAdvanced, setShowAdvanced] = useState(source !== "all");
  const reduceMotion = useReducedMotion();

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

      <section className="rounded-2xl border border-border-default bg-surface-raised">
        <button
          type="button"
          aria-expanded={showAdvanced}
          aria-controls="earn-advanced-preferences"
          onClick={() => setShowAdvanced((current) => !current)}
          className="flex min-h-12 w-full items-center justify-between gap-4 rounded-2xl px-4 py-3 text-left transition-colors hover:bg-fill-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
        >
          <span className="flex min-w-0 items-center gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-fill-subtle text-secondary">
              <Layers3Icon className="size-4" />
            </span>
            <span>
              <span className="block text-sm font-medium text-primary">
                {showAdvanced
                  ? t("DashboardEarn.setup.hideAdvancedPreferences")
                  : t("DashboardEarn.setup.advancedPreferences")}
              </span>
              <span className="mt-0.5 block text-[13px] leading-5 text-tertiary">
                {t("DashboardEarn.setup.yieldSourceDescription")}
              </span>
            </span>
          </span>
          <ChevronDownIcon
            className={cn(
              "size-4 shrink-0 text-tertiary transition-transform duration-200 motion-reduce:transition-none",
              showAdvanced && "rotate-180"
            )}
          />
        </button>

        <div id="earn-advanced-preferences">
          <AnimatePresence initial={false}>
            {showAdvanced ? (
              <motion.div
                initial={reduceMotion ? false : { opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
                transition={{ duration: reduceMotion ? 0 : 0.18, ease: "easeOut" }}
                className="overflow-hidden"
              >
                <div className="border-t border-border-subtle px-4 pt-4 pb-4">
                  <p className="mb-3 text-sm font-medium text-primary">
                    {t("DashboardEarn.setup.yieldSourceTitle")}
                  </p>
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
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </section>

      <div className="flex flex-col gap-3 border-t border-border-subtle pt-5 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-xl text-[13px] leading-5 text-tertiary">
          {t("DashboardEarn.setup.preferencesRankCurators")}
        </p>
        <Button type="button" variant="ghost" size="sm" onClick={onBrowseAll}>
          {t("DashboardEarn.setup.browseAllCurators")}
        </Button>
      </div>
    </div>
  );
}

function CuratorFact({ label, value }: { label: string; value: string }) {
  return (
    <span className="min-w-0 rounded-xl bg-fill-subtle px-3 py-2.5">
      <span className="block text-[11px] font-medium tracking-[0.04em] text-tertiary uppercase">
        {label}
      </span>
      <span className="mt-1 block text-[13px] leading-5 font-medium text-primary">{value}</span>
    </span>
  );
}

function UnderlyingHoldings({
  strategies,
  allocation,
  tokenMint,
  amount,
}: {
  strategies: readonly MockEarnStrategy[];
  allocation?: Allocation;
  tokenMint?: string;
  amount?: number;
}) {
  const t = useTranslations();
  const liquidityLabel = useLiquidityLabel();

  return (
    <div className="divide-y divide-border-subtle">
      {strategies.map((strategy) => {
        const pct = allocation?.[strategy.id];
        return (
          <div
            key={strategy.id}
            className="grid gap-3 py-3 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium text-primary">{strategy.name}</p>
              <p className="mt-1 text-xs leading-5 text-tertiary">
                {t(`DashboardEarn.source.${strategy.sourceKind}`)} ·{" "}
                {t(`DashboardEarn.risk.${strategy.riskTier}`)} · {liquidityLabel(strategy)}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {strategy.depositMints.map((mint) => (
                  <span
                    key={mint}
                    className="rounded-md bg-fill px-2 py-1 text-[11px] font-medium text-secondary"
                  >
                    {tokenSymbol(mint)}
                  </span>
                ))}
              </div>
            </div>
            <div className="text-left sm:text-right">
              <p className="text-sm font-medium text-primary">{formatApy(strategy.currentApy)}</p>
              {pct !== undefined ? (
                <p className="mt-1 text-xs text-secondary">
                  {t("DashboardEarn.setup.routingEstimate", { percent: pct })}
                  {tokenMint && amount !== undefined
                    ? ` · ${formatTokenAmount(amount * (pct / 100), tokenMint)}`
                    : ""}
                </p>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PortfolioDisclosure({
  strategies,
  allocation,
  tokenMint,
  amount,
  routing = false,
}: {
  strategies: readonly MockEarnStrategy[];
  allocation?: Allocation;
  tokenMint?: string;
  amount?: number;
  routing?: boolean;
}) {
  const t = useTranslations();
  const reduceMotion = useReducedMotion();
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();

  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpanded((current) => !current)}
        className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg px-1 py-2 text-left text-[13px] font-medium text-secondary transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
      >
        <span>
          {routing
            ? t(
                expanded
                  ? "DashboardEarn.setup.hideRoutingDetails"
                  : "DashboardEarn.setup.viewRoutingDetails"
              )
            : t(
                expanded
                  ? "DashboardEarn.setup.hideAvailableOpportunities"
                  : "DashboardEarn.setup.viewAvailableOpportunities"
              )}
        </span>
        <ChevronDownIcon
          className={cn(
            "size-4 shrink-0 transition-transform duration-200 motion-reduce:transition-none",
            expanded && "rotate-180"
          )}
        />
      </button>
      <div id={contentId}>
        <AnimatePresence initial={false}>
          {expanded ? (
            <motion.div
              initial={reduceMotion ? false : { opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.18, ease: "easeOut" }}
              className="overflow-hidden"
            >
              <div className="border-t border-border-subtle pt-3 pb-1">
                <p className="mb-3 text-xs leading-5 text-tertiary">
                  {t(
                    routing
                      ? "DashboardEarn.setup.routingTransparency"
                      : "DashboardEarn.setup.opportunityTransparency"
                  )}
                </p>
                <UnderlyingHoldings
                  strategies={strategies}
                  allocation={allocation}
                  tokenMint={tokenMint}
                  amount={amount}
                />
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
}

function CuratorCard({
  program,
  selected,
  preferenceMatch,
  showPreferenceFit,
  initialStrategy,
  onSelect,
}: {
  program: CuratorProgram;
  selected: boolean;
  preferenceMatch: boolean;
  showPreferenceFit: boolean;
  initialStrategy: MockEarnStrategy | undefined;
  onSelect: () => void;
}) {
  const t = useTranslations();
  const inputId = `earn-curator-${program.id}`;
  const nameId = `${inputId}-name`;
  const headlineId = `${inputId}-headline`;
  const descriptionId = `${inputId}-description`;
  const curatorName = earnCuratorLabel(program.id);

  return (
    <article
      className={cn(
        "rounded-2xl border bg-surface-raised transition-[border-color,background-color,box-shadow] duration-200 ease-out motion-reduce:transition-none",
        selected
          ? "border-primary bg-fill-subtle shadow-sm"
          : "border-border-default hover:border-border-strong"
      )}
    >
      <input
        id={inputId}
        className="peer sr-only"
        type="radio"
        name="earn-curator"
        value={program.id}
        checked={selected}
        aria-labelledby={`${nameId} ${headlineId}`}
        aria-describedby={descriptionId}
        onChange={onSelect}
      />
      <label
        htmlFor={inputId}
        className="block cursor-pointer rounded-2xl p-4 focus-within:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-primary/40 sm:p-5"
      >
        <span className="flex items-start gap-3.5">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-border-subtle bg-fill text-sm font-semibold text-primary">
            {curatorMonogram(program.id)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-start justify-between gap-3">
              <span>
                <span
                  id={nameId}
                  className="block text-base font-medium tracking-tight text-primary"
                >
                  {curatorName}
                </span>
                <span id={headlineId} className="mt-1 block text-sm font-medium text-secondary">
                  {t(curatorProfileKey(program.id, "headline"))}
                </span>
              </span>
              <SelectionMark selected={selected} />
            </span>
            <span
              id={descriptionId}
              className="mt-3 block max-w-2xl text-[13px] leading-5 text-secondary"
            >
              {t(curatorProfileKey(program.id, "description"))}
            </span>
            <span className="mt-2 block text-[13px] leading-5 text-primary">
              <span className="font-medium">{t("DashboardEarn.setup.bestFor")}</span>{" "}
              {t(curatorProfileKey(program.id, "bestFor"))}
            </span>
          </span>
        </span>

        <span className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
          <CuratorFact
            label={t("DashboardEarn.setup.indicativeApyRange")}
            value={curatorApyRange(program)}
          />
          <CuratorFact
            label={t("DashboardEarn.setup.riskRange")}
            value={t(curatorProfileKey(program.id, "risk"))}
          />
          <CuratorFact
            label={t("DashboardEarn.setup.liquidity")}
            value={t(curatorProfileKey(program.id, "liquidity"))}
          />
          <CuratorFact
            label={t("DashboardEarn.setup.fundingAssets")}
            value={program.depositMints.map(tokenSymbol).join(", ")}
          />
        </span>

        {showPreferenceFit || initialStrategy ? (
          <span className="mt-3 flex flex-wrap items-center gap-2">
            {showPreferenceFit ? (
              <Badge variant={preferenceMatch ? "info" : "default"}>
                {preferenceMatch
                  ? t("DashboardEarn.setup.includesPreferenceMatch")
                  : t("DashboardEarn.setup.noDirectPreferenceOverlap")}
              </Badge>
            ) : null}
            {initialStrategy ? (
              <span className="text-xs text-secondary">
                {t("DashboardEarn.setup.includesStrategy", { strategy: initialStrategy.name })}
              </span>
            ) : null}
          </span>
        ) : null}
      </label>
      <div className="border-t border-border-subtle px-4 sm:px-5">
        <PortfolioDisclosure strategies={program.strategies} />
      </div>
    </article>
  );
}

function CuratorStep({
  selectedCuratorId,
  riskTier,
  source,
  initialStrategy,
  onCuratorChange,
}: {
  selectedCuratorId: string | null;
  riskTier: EarnRiskTier | null;
  source: AssetPreference;
  initialStrategy: MockEarnStrategy | undefined;
  onCuratorChange: (curatorId: string) => void;
}) {
  const t = useTranslations();
  const showPreferenceFit = riskTier !== null || source !== "all";

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3 rounded-2xl border border-border-default bg-fill-subtle p-4">
        <ShieldCheckIcon className="mt-0.5 size-5 shrink-0 text-secondary" />
        <div>
          <p className="text-sm font-medium text-primary">
            {t("DashboardEarn.setup.whatCuratorDoesTitle")}
          </p>
          <p className="mt-1 text-[13px] leading-5 text-secondary">
            {t("DashboardEarn.setup.whatCuratorDoesDescription")}
          </p>
        </div>
      </div>

      <fieldset className="space-y-3">
        <legend className="sr-only">{t("DashboardEarn.setup.curatorsTitle")}</legend>
        {CURATOR_PROGRAMS.map((program) => (
          <CuratorCard
            key={program.id}
            program={program}
            selected={program.id === selectedCuratorId}
            preferenceMatch={curatorMatchesPreferences(program.id, MOCK_EARN_STRATEGIES, {
              riskTier,
              source,
            })}
            showPreferenceFit={showPreferenceFit}
            initialStrategy={initialStrategy?.curator === program.id ? initialStrategy : undefined}
            onSelect={() => onCuratorChange(program.id)}
          />
        ))}
      </fieldset>

      <p className="flex items-start gap-2.5 rounded-xl border border-border-subtle bg-fill-subtle px-3.5 py-3 text-[13px] leading-5 text-secondary">
        <SparklesIcon className="mt-0.5 size-4 shrink-0" />
        <span>{t("DashboardEarn.setup.curatorMockNotice")}</span>
      </p>
      <p className="sr-only" role="status" aria-live="polite">
        {selectedCuratorId
          ? t("DashboardEarn.setup.selectedCuratorAnnouncement", {
              curator: earnCuratorLabel(selectedCuratorId),
            })
          : ""}
      </p>
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
  program,
  onDestinationChange,
  onEdit,
}: {
  wallet: MockEarnWallet | undefined;
  destination: EarnDestination | null;
  riskTier: EarnRiskTier | null;
  source: AssetPreference;
  program: CuratorProgram | undefined;
  onDestinationChange: (destination: EarnDestination) => void;
  onEdit: (step: SetupStep) => void;
}) {
  const t = useTranslations();
  const curatorName = program ? earnCuratorLabel(program.id) : "—";

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
        <p className="border-t border-border-subtle py-3 text-xs leading-5 text-tertiary">
          {t("DashboardEarn.setup.preferencesDiscoveryOnly")}
        </p>
      </ReviewSection>

      <ReviewSection
        icon={<ShieldCheckIcon className="size-4" />}
        title={t("DashboardEarn.setup.reviewCurator")}
        onEdit={() => onEdit("curator")}
      >
        <SummaryRow label={t("DashboardEarn.setup.curator")} value={curatorName} />
        <SummaryRow
          label={t("DashboardEarn.setup.managedProgram")}
          value={program ? t(curatorProfileKey(program.id, "headline")) : "—"}
        />
        <SummaryRow
          label={t("DashboardEarn.setup.indicativeApyRange")}
          value={curatorApyRange(program)}
        />
        <SummaryRow
          label={t("DashboardEarn.setup.riskRange")}
          value={program ? t(curatorProfileKey(program.id, "risk")) : "—"}
        />
        <SummaryRow
          label={t("DashboardEarn.setup.liquidity")}
          value={program ? t(curatorProfileKey(program.id, "liquidity")) : "—"}
        />
        <SummaryRow
          label={t("DashboardEarn.setup.fundingAssets")}
          value={program ? program.depositMints.map(tokenSymbol).join(", ") : "—"}
        />
        <SummaryRow
          label={t("DashboardEarn.setup.allocation")}
          value={t("DashboardEarn.setup.curatorManaged")}
        />
        {program ? (
          <div className="border-t border-border-subtle">
            <PortfolioDisclosure strategies={program.strategies} />
          </div>
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
  program,
  ready,
}: {
  wallet: MockEarnWallet | undefined;
  destination: EarnDestination | null;
  riskTier: EarnRiskTier | null;
  program: CuratorProgram | undefined;
  ready: boolean;
}) {
  const t = useTranslations();
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
            label={t("DashboardEarn.setup.curator")}
            value={program ? earnCuratorLabel(program.id) : "—"}
          />
          <SummaryRow
            label={t("DashboardEarn.setup.indicativeApyRange")}
            value={curatorApyRange(program)}
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
  program,
  strategies,
  allocation,
  tokenMint,
  amountInput,
  submitting,
  onTokenChange,
  onAmountChange,
  onBack,
  onSubmit,
}: {
  wallet: MockEarnWallet;
  program: CuratorProgram;
  strategies: readonly MockEarnStrategy[];
  allocation: Allocation;
  tokenMint: string;
  amountInput: string;
  submitting: boolean;
  onTokenChange: (mint: string) => void;
  onAmountChange: (value: string) => void;
  onBack: () => void;
  onSubmit: () => void;
}) {
  const t = useTranslations();
  const curatorName = earnCuratorLabel(program.id);
  const eligibleMints = program.depositMints;
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
      title={t("DashboardEarn.setup.fundCuratorProgramTitle", { curator: curatorName })}
      description={t("DashboardEarn.setup.fundCuratorProgramDescription", {
        curator: curatorName,
      })}
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
            <SummaryRow
              label={t("DashboardEarn.setup.managedBy", { curator: curatorName })}
              value={amountValid ? formatTokenAmount(amount, tokenMint) : "—"}
            />
            <SummaryRow
              label={t("DashboardEarn.setup.projectedYearlyYield")}
              value={amountValid ? formatUsd(projectedYield) : "—"}
            />
            <SummaryRow
              label={t("DashboardEarn.setup.networkFee")}
              value={t("DashboardEarn.setup.sponsored")}
            />
            <div className="border-t border-border-subtle">
              <PortfolioDisclosure
                strategies={strategies}
                allocation={allocation}
                tokenMint={tokenMint}
                amount={amountValid ? amount : undefined}
                routing
              />
            </div>
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
  program,
  onBack,
  onContinue,
}: {
  program: CuratorProgram;
  onBack: () => void;
  onContinue: () => void;
}) {
  const t = useTranslations();
  const estimatedApyRange = curatorApyRange(program);
  const curatorName = earnCuratorLabel(program.id);
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
            <SummaryRow label={t("DashboardEarn.setup.curator")} value={curatorName} />
            <SummaryRow
              label={t("DashboardEarn.setup.indicativeApyRange")}
              value={estimatedApyRange}
            />
            <SummaryRow
              label={t("DashboardEarn.setup.fundingAssets")}
              value={program.depositMints.map(tokenSymbol).join(", ")}
            />
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
                    {estimatedApyRange}
                  </span>
                  {t("DashboardEarn.setup.indicativeApyRange")}
                </p>
              </div>

              <div className="mt-6 rounded-2xl border border-border-default bg-fill-subtle p-4 sm:p-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border-subtle bg-surface-raised text-sm font-semibold text-primary">
                      {curatorMonogram(program.id)}
                    </span>
                    <div>
                      <p className="text-base font-medium tracking-tight text-primary">
                        {t(curatorProfileKey(program.id, "headline"))}
                      </p>
                      <p className="mt-1 text-xs text-secondary">
                        {t("DashboardEarn.setup.retailManagedBy", { curator: curatorName })}
                      </p>
                    </div>
                  </div>
                  <Badge variant="info">{t("DashboardEarn.setup.curatorManaged")}</Badge>
                </div>
                <p className="mt-4 max-w-2xl text-[13px] leading-5 text-secondary">
                  {t(curatorProfileKey(program.id, "description"))}
                </p>
                <div className="mt-4 grid grid-cols-2 gap-2">
                  <CuratorFact
                    label={t("DashboardEarn.setup.indicativeApyRange")}
                    value={estimatedApyRange}
                  />
                  <CuratorFact
                    label={t("DashboardEarn.setup.liquidity")}
                    value={t(curatorProfileKey(program.id, "liquidity"))}
                  />
                </div>
                <div className="mt-2">
                  <PortfolioDisclosure strategies={program.strategies} />
                </div>
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

function RetailIntegrationScreen({
  program,
  onBack,
  onDone,
}: {
  program: CuratorProgram;
  onBack: () => void;
  onDone: () => void;
}) {
  const t = useTranslations();
  const curatorName = earnCuratorLabel(program.id);
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
              <SummaryRow
                label={t("DashboardEarn.setup.managedProgram")}
                value={t("DashboardEarn.setup.managedBy", { curator: curatorName })}
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
  program,
  strategies,
  allocation,
  amount,
  tokenMint,
  onAnother,
  onDashboard,
}: {
  program: CuratorProgram;
  strategies: readonly MockEarnStrategy[];
  allocation: Allocation;
  amount: number;
  tokenMint: string;
  onAnother: () => void;
  onDashboard: () => void;
}) {
  const t = useTranslations();
  const estimatedApy = weightedApy(strategies, allocation);
  const curatorName = earnCuratorLabel(program.id);
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
      <div
        className="flex items-start gap-3 rounded-2xl border border-success-border bg-success-bg p-4 text-success"
        role="status"
      >
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
            {t("DashboardEarn.setup.curatorAllocation")}
          </h3>
        </div>
        <div className="px-4 py-2">
          <SummaryRow label={t("DashboardEarn.setup.curator")} value={curatorName} />
          <SummaryRow
            label={t("DashboardEarn.setup.managedProgram")}
            value={t(curatorProfileKey(program.id, "headline"))}
          />
          <SummaryRow
            label={t("DashboardEarn.setup.allocation")}
            value={t("DashboardEarn.setup.curatorManaged")}
          />
          <div className="border-t border-border-subtle">
            <PortfolioDisclosure
              strategies={strategies}
              allocation={allocation}
              tokenMint={tokenMint}
              amount={amount}
              routing
            />
          </div>
        </div>
      </section>
    </PostSetupFrame>
  );
}

interface EarnDepositWizardProps {
  initialStrategyId?: string;
  initialCuratorId?: string;
}

interface SetupReadinessInput {
  wallet: MockEarnWallet | undefined;
  program: CuratorProgram | undefined;
  destination: EarnDestination | null;
}

function getSetupReadiness({
  wallet,
  program,
  destination,
}: SetupReadinessInput): Record<SetupStep, boolean> {
  const curatorReady = Boolean(program && program.depositMints.length > 0);

  return {
    wallet: Boolean(wallet),
    profile: true,
    curator: curatorReady,
    review: Boolean(wallet) && curatorReady && Boolean(destination),
  };
}

function nextSetupStep(step: SetupStep): SetupStep | null {
  if (step === "wallet") return "profile";
  if (step === "profile") return "curator";
  if (step === "curator") return "review";
  return null;
}

function previousSetupStep(step: SetupStep): SetupStep | null {
  if (step === "profile") return "wallet";
  if (step === "curator") return "profile";
  if (step === "review") return "curator";
  return null;
}

function primaryActionLabel(
  step: SetupStep,
  destination: EarnDestination | null,
  selectedCuratorId: string | null,
  editingFromReview: boolean,
  t: ReturnType<typeof useTranslations>
): string {
  if (editingFromReview) return t("DashboardEarn.setup.saveChanges");
  if (step === "wallet") return t("DashboardEarn.setup.importWallet");
  if (step === "profile") return t("DashboardEarn.setup.seeCuratorPrograms");
  if (step === "curator") {
    return selectedCuratorId
      ? t("DashboardEarn.setup.continueWithCurator", {
          curator: earnCuratorLabel(selectedCuratorId),
        })
      : t("DashboardEarn.setup.selectCurator");
  }
  if (destination === null) return t("DashboardEarn.setup.chooseDestination");
  return destination === "retail"
    ? t("DashboardEarn.setup.createEarnExperience")
    : t("DashboardEarn.setup.createVault");
}

interface PostSetupContentProps {
  screen: PostSetupScreen;
  wallet: MockEarnWallet | undefined;
  program: CuratorProgram | undefined;
  strategies: readonly MockEarnStrategy[];
  allocation: Allocation;
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
  program,
  strategies,
  allocation,
  tokenMint,
  amountInput,
  submitting,
  onTokenChange,
  onAmountChange,
  onScreenChange,
  onSubmitDeposit,
  onDashboard,
}: PostSetupContentProps) {
  if (!program) return null;
  if (screen === "treasury" && wallet) {
    return (
      <TreasuryFundingScreen
        wallet={wallet}
        program={program}
        strategies={strategies}
        allocation={allocation}
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
        program={program}
        onBack={() => onScreenChange(null)}
        onContinue={() => onScreenChange("retail-integration")}
      />
    );
  }
  if (screen === "retail-integration") {
    return (
      <RetailIntegrationScreen
        program={program}
        onBack={() => onScreenChange("retail-preview")}
        onDone={onDashboard}
      />
    );
  }
  if (screen === "vault-live") {
    return (
      <VaultLiveScreen
        program={program}
        strategies={strategies}
        allocation={allocation}
        amount={Number(amountInput)}
        tokenMint={tokenMint}
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
  selectedCuratorId: string | null;
  program: CuratorProgram | undefined;
  initialStrategy: MockEarnStrategy | undefined;
  onProviderChange: (provider: WalletProvider) => void;
  onWalletChange: (walletId: string) => void;
  onDestinationChange: (destination: EarnDestination | null) => void;
  onRiskTierChange: (riskTier: EarnRiskTier | null) => void;
  onSourceChange: (source: AssetPreference) => void;
  onCuratorChange: (curatorId: string) => void;
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
  if (props.step === "curator") {
    return (
      <CuratorStep
        selectedCuratorId={props.selectedCuratorId}
        riskTier={props.riskTier}
        source={props.source}
        initialStrategy={props.initialStrategy}
        onCuratorChange={props.onCuratorChange}
      />
    );
  }
  return (
    <ReviewStep
      wallet={MOCK_EARN_WALLETS.find((candidate) => candidate.id === props.walletId)}
      destination={props.destination}
      riskTier={props.riskTier}
      source={props.source}
      program={props.program}
      onDestinationChange={(next) => props.onDestinationChange(next)}
      onEdit={props.onEdit}
    />
  );
}

export function EarnDepositWizard({ initialStrategyId, initialCuratorId }: EarnDepositWizardProps) {
  const t = useTranslations();
  const router = useDashboardRouter();
  const initialStrategy = MOCK_EARN_STRATEGIES.find(
    (strategy) => strategy.id === initialStrategyId
  );
  const initialCurator = CURATOR_PROGRAMS.find((program) => program.id === initialCuratorId);

  const [step, setStep] = useState<SetupStep>("wallet");
  const [editingFromReview, setEditingFromReview] = useState(false);
  const [postSetupScreen, setPostSetupScreen] = useState<PostSetupScreen | null>(null);
  const [provider, setProvider] = useState<WalletProvider | null>(null);
  const [walletId, setWalletId] = useState("");
  const [destination, setDestination] = useState<EarnDestination | null>(null);
  const [riskTier, setRiskTier] = useState<EarnRiskTier | null>(initialStrategy?.riskTier ?? null);
  const [source, setSource] = useState<AssetPreference>(initialStrategy?.sourceKind ?? "all");
  const [selectedCuratorId, setSelectedCuratorId] = useState<string | null>(
    initialStrategy?.curator ?? initialCurator?.id ?? null
  );
  const [tokenMint, setTokenMint] = useState(
    initialStrategy?.depositMints[0] ?? DEFAULT_DEPOSIT_MINT
  );
  const [amountInput, setAmountInput] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const wallet = MOCK_EARN_WALLETS.find((candidate) => candidate.id === walletId);
  const program = CURATOR_PROGRAMS.find((candidate) => candidate.id === selectedCuratorId);
  const fundingPlan = useMemo(
    () =>
      selectedCuratorId
        ? buildCuratorFundingPlan(selectedCuratorId, tokenMint, MOCK_EARN_STRATEGIES)
        : null,
    [selectedCuratorId, tokenMint]
  );
  const strategies = fundingPlan?.strategies ?? [];
  const effectiveAllocation = fundingPlan?.strategyAllocation ?? {};

  const progressStep = SETUP_PROGRESS.indexOf(step);
  const stepReady = getSetupReadiness({
    wallet,
    program,
    destination,
  });

  const chooseProvider = (nextProvider: WalletProvider) => {
    setProvider(nextProvider);
    const firstWallet = MOCK_EARN_WALLETS.find((candidate) => candidate.provider === nextProvider);
    setWalletId(firstWallet?.id ?? "");
  };

  const chooseCurator = (curatorId: string) => {
    setSelectedCuratorId(curatorId);
    const nextProgram = CURATOR_PROGRAMS.find((candidate) => candidate.id === curatorId);
    if (nextProgram && !nextProgram.depositMints.includes(tokenMint)) {
      setTokenMint(
        nextProgram.depositMints.includes(DEFAULT_DEPOSIT_MINT)
          ? DEFAULT_DEPOSIT_MINT
          : (nextProgram.depositMints[0] ?? DEFAULT_DEPOSIT_MINT)
      );
    }
  };

  const moveTo = (nextStep: SetupStep) => {
    setStep(nextStep);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: Every wizard step transition must land already scrolled to the top with its heading announced.
  useLayoutEffect(() => {
    // Pre-paint so the new step's first frame is already at the top — no visible
    // jump or smooth-scroll drift after the content appears.
    const scrollRegion = document.querySelector<HTMLElement>(
      postSetupScreen ? "[data-earn-post-setup-scroll]" : "[data-wizard-scroll-region]"
    );
    if (!scrollRegion) return;

    scrollRegion.scrollTo({ top: 0, behavior: "instant" });
    const heading = scrollRegion.querySelector<HTMLHeadingElement>("h2");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  }, [step, postSetupScreen]);

  const goNext = () => {
    if (!stepReady[step]) return;
    if (editingFromReview) {
      setEditingFromReview(false);
      moveTo("review");
      return;
    }
    const nextStep = nextSetupStep(step);
    if (nextStep) {
      moveTo(nextStep);
      return;
    }
    if (destination) {
      setPostSetupScreen(destination === "treasury" ? "treasury" : "retail-preview");
    }
  };

  const goBack = () => {
    if (editingFromReview) {
      setEditingFromReview(false);
      moveTo("review");
      return;
    }
    const previousStep = previousSetupStep(step);
    if (!previousStep) {
      router.push("/dashboard/markets/earn");
      return;
    }
    moveTo(previousStep);
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
        program={program}
        strategies={strategies}
        allocation={effectiveAllocation}
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
  const showSummaryRail = step !== "wallet" && step !== "curator";
  const primaryLabel = primaryActionLabel(
    step,
    destination,
    selectedCuratorId,
    editingFromReview,
    t
  );

  return (
    <WizardFrame
      steps={SETUP_PROGRESS.map((progress) => ({
        label: t(`DashboardEarn.setup.progress.${progress}` as MessageKey),
        title: t(stepMeta[progress].title),
      }))}
      currentStep={progressStep}
      progressLabel={t("DashboardEarn.setup.stepProgress", {
        current: progressStep + 1,
        total: SETUP_PROGRESS.length,
      })}
      description={t(activeMeta.description)}
      maxWidthClassName="max-w-4xl"
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
        {/* Step content swaps instantly: wizard steps must land pre-scrolled to the
            top with no transition (see the useLayoutEffect scroll reset above). */}
        <div className="relative min-h-[22rem]">
          <SetupStepContent
            step={step}
            provider={provider}
            walletId={walletId}
            destination={destination}
            riskTier={riskTier}
            source={source}
            selectedCuratorId={selectedCuratorId}
            program={program}
            initialStrategy={initialStrategy}
            onProviderChange={chooseProvider}
            onWalletChange={setWalletId}
            onDestinationChange={setDestination}
            onRiskTierChange={setRiskTier}
            onSourceChange={setSource}
            onCuratorChange={chooseCurator}
            onBrowseAll={() => {
              setRiskTier(null);
              setSource("all");
              moveTo("curator");
            }}
            onEdit={(target) => {
              setEditingFromReview(true);
              moveTo(target);
            }}
          />
        </div>

        {showSummaryRail ? (
          <ProgramSummaryRail
            wallet={wallet}
            destination={destination}
            riskTier={riskTier}
            program={program}
            ready={stepReady.review}
          />
        ) : null}
      </div>
    </WizardFrame>
  );
}
