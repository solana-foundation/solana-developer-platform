"use client";

import { earnCuratorLabel } from "@sdp/types";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BanknoteIcon,
  CheckIcon,
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
  type MockEarnWallet,
  projectYearlyYield,
  tokenSymbol,
} from "../earn-mock-data";
import { addMockPosition } from "../earn-mock-positions";

const STEP_IDS = ["profile", "strategy", "amount", "review"] as const;
type StepId = (typeof STEP_IDS)[number];

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

function useLiquidityLabel() {
  const t = useTranslations();
  return (strategy: MockEarnStrategy): string =>
    strategy.liquidityTerm === "instant"
      ? t("DashboardEarn.liquidity.instant")
      : t("DashboardEarn.liquidity.delayed", { days: strategy.redemptionDelayDays ?? 1 });
}

function RadioDot({ selected }: { selected: boolean }) {
  return (
    <span
      className={cn(
        "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2",
        selected ? "border-primary" : "border-border-strong"
      )}
      aria-hidden
    >
      {selected ? <span className="h-2 w-2 rounded-full bg-primary" /> : null}
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

function StrategyStep({
  choices,
  curators,
  curatorFilter,
  strategyId,
  onCuratorFilter,
  onSelect,
}: {
  choices: readonly MockEarnStrategy[];
  curators: readonly string[];
  curatorFilter: string | null;
  strategyId: string | null;
  onCuratorFilter: (curator: string | null) => void;
  onSelect: (strategy: MockEarnStrategy) => void;
}) {
  const t = useTranslations();
  const liquidityLabel = useLiquidityLabel();

  return (
    <div className="space-y-4">
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

      {choices.length === 0 ? (
        <p className="rounded-md border border-border-default p-4 text-sm text-tertiary">
          {t("DashboardEarn.wizard.noStrategiesForFilters")}
        </p>
      ) : (
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
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-primary">{candidate.name}</p>
                    <p className="mt-0.5 text-xs text-secondary">
                      {t(`DashboardEarn.source.${candidate.sourceKind}`)} ·{" "}
                      {earnCuratorLabel(candidate.curator)}
                    </p>
                  </div>
                  <RadioDot selected={selected} />
                </div>
                <div className="mt-3 flex items-center justify-between text-[13px]">
                  <span className="text-primary">
                    {formatApy(candidate.currentApy)}{" "}
                    <span className="text-secondary">
                      {t(`DashboardEarn.apyType.${candidate.apyType}`)}
                    </span>
                  </span>
                  <span className="text-secondary">{liquidityLabel(candidate)}</span>
                  <span className="text-secondary">{formatUsdCompact(candidate.tvlUsd)}</span>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AmountStep({
  strategy,
  walletId,
  tokenMint,
  amountInput,
  amount,
  amountValid,
  balance,
  onWalletChange,
  onTokenChange,
  onAmountChange,
}: {
  strategy: MockEarnStrategy;
  walletId: string;
  tokenMint: string;
  amountInput: string;
  amount: number;
  amountValid: boolean;
  balance: number;
  onWalletChange: (walletId: string) => void;
  onTokenChange: (mint: string) => void;
  onAmountChange: (value: string) => void;
}) {
  const t = useTranslations();

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>{t("DashboardEarn.wizard.walletLabel")}</Label>
          <Select
            size="xl"
            className="w-full"
            iconLeft={<WalletIcon />}
            placeholder={t("DashboardEarn.wizard.selectWallet")}
            value={walletId}
            onValueChange={(value) => onWalletChange(value === null ? "" : value)}
          >
            {MOCK_EARN_WALLETS.map((candidate) => (
              <SelectItem key={candidate.id} value={candidate.id}>
                {candidate.name}
              </SelectItem>
            ))}
          </Select>
        </div>
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
            {strategy.depositMints.map((mint) => (
              <SelectItem key={mint} value={mint}>
                {tokenSymbol(mint)}
              </SelectItem>
            ))}
          </Select>
        </div>
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
            <button
              type="button"
              onClick={() => onAmountChange(String(balance))}
              className="pointer-events-auto text-xs font-medium text-primary"
            >
              {t("DashboardEarn.wizard.useMax")}
            </button>
          }
        />
        <p className="text-xs text-secondary">
          {t("DashboardEarn.wizard.available", {
            amount: formatTokenAmount(balance, tokenMint),
          })}
        </p>
        {amountInput && !amountValid ? (
          <p className="text-xs text-error">
            {amount > balance
              ? t("DashboardEarn.wizard.errorInsufficientBalance")
              : t("DashboardEarn.wizard.errorAmountRequired")}
          </p>
        ) : null}
      </div>

      {amountValid ? (
        <div className="rounded-md border border-border-default bg-fill-subtle p-3">
          <p className="text-xs text-secondary">{t("DashboardEarn.wizard.projectedYieldTitle")}</p>
          <p className="mt-1 text-sm text-primary">
            {t("DashboardEarn.wizard.projectedYieldPerYear", {
              amount: formatUsd(projectYearlyYield(amount, strategy.currentApy)),
            })}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function ReviewStep({
  strategy,
  wallet,
  amount,
  tokenMint,
}: {
  strategy: MockEarnStrategy;
  wallet: MockEarnWallet;
  amount: number;
  tokenMint: string;
}) {
  const t = useTranslations();
  const liquidityLabel = useLiquidityLabel();

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border-default p-4">
        <SummaryRow label={t("DashboardEarn.wizard.summaryStrategy")} value={strategy.name} />
        <SummaryRow
          label={t("DashboardEarn.wizard.summaryCurator")}
          value={earnCuratorLabel(strategy.curator)}
        />
        <SummaryRow
          label={t("DashboardEarn.wizard.summaryApy")}
          value={`${formatApy(strategy.currentApy)} ${t(
            `DashboardEarn.apyType.${strategy.apyType}`
          )}`}
        />
        <SummaryRow
          label={t("DashboardEarn.wizard.summaryLiquidity")}
          value={liquidityLabel(strategy)}
        />
        <SummaryRow label={t("DashboardEarn.wizard.summaryWallet")} value={wallet.name} />
        <SummaryRow
          label={t("DashboardEarn.wizard.summaryAmount")}
          value={formatTokenAmount(amount, tokenMint)}
        />
        <SummaryRow
          label={t("DashboardEarn.wizard.summaryProjectedYield")}
          value={formatUsd(projectYearlyYield(amount, strategy.currentApy))}
        />
      </div>
      <p className="text-xs text-tertiary">{t("DashboardEarn.wizard.mockConfirmNote")}</p>
    </div>
  );
}

function SummaryRail({
  riskTier,
  strategy,
  wallet,
  amount,
  amountValid,
  tokenMint,
  showFunding,
}: {
  riskTier: EarnRiskTier | null;
  strategy: MockEarnStrategy | undefined;
  wallet: MockEarnWallet | undefined;
  amount: number;
  amountValid: boolean;
  tokenMint: string;
  showFunding: boolean;
}) {
  const t = useTranslations();
  const liquidityLabel = useLiquidityLabel();

  return (
    <aside className="hidden lg:block">
      <div className="sticky top-2 rounded-lg border border-border-default bg-surface-raised p-4">
        <h3 className="text-sm font-medium text-primary">
          {t("DashboardEarn.wizard.summaryTitle")}
        </h3>
        {riskTier === null && !strategy ? (
          <p className="mt-3 text-xs text-tertiary">{t("DashboardEarn.wizard.summaryEmpty")}</p>
        ) : (
          <div className="mt-3">
            {riskTier ? (
              <SummaryRow
                label={t("DashboardEarn.wizard.summaryRisk")}
                value={t(`DashboardEarn.risk.${riskTier}`)}
              />
            ) : null}
            {strategy ? (
              <>
                <SummaryRow
                  label={t("DashboardEarn.wizard.summaryStrategy")}
                  value={strategy.name}
                />
                <SummaryRow
                  label={t("DashboardEarn.wizard.summaryApy")}
                  value={formatApy(strategy.currentApy)}
                />
                <SummaryRow
                  label={t("DashboardEarn.wizard.summaryLiquidity")}
                  value={liquidityLabel(strategy)}
                />
              </>
            ) : null}
            {wallet && showFunding ? (
              <SummaryRow label={t("DashboardEarn.wizard.summaryWallet")} value={wallet.name} />
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
  strategy,
  amount,
  tokenMint,
}: {
  strategy: MockEarnStrategy;
  amount: number;
  tokenMint: string;
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
          <SummaryRow label={t("DashboardEarn.wizard.summaryStrategy")} value={strategy.name} />
          <SummaryRow
            label={t("DashboardEarn.wizard.summaryAmount")}
            value={formatTokenAmount(amount, tokenMint)}
          />
          <SummaryRow
            label={t("DashboardEarn.wizard.summaryProjectedYield")}
            value={formatUsd(projectYearlyYield(amount, strategy.currentApy))}
          />
        </div>
        <div className="mt-5 flex items-center justify-center gap-3">
          <Button variant="secondary" onClick={() => router.push("/dashboard/earn/deposit")}>
            {t("DashboardEarn.wizard.successAnother")}
          </Button>
          <Button onClick={() => router.push("/dashboard/earn")}>
            {t("DashboardEarn.wizard.viewPositions")}
          </Button>
        </div>
      </div>
    </div>
  );
}

interface EarnDepositWizardProps {
  initialStrategyId?: string;
}

export function EarnDepositWizard({ initialStrategyId }: EarnDepositWizardProps) {
  const t = useTranslations();
  const router = useDashboardRouter();

  const initialStrategy = initialStrategyId ? getMockStrategy(initialStrategyId) : undefined;

  // A catalogue row's Deposit action lands directly on the amount step with
  // the profile + strategy pre-filled — the walkthrough is for discovery, not
  // a toll gate.
  const [step, setStep] = useState(initialStrategy ? 2 : 0);
  const [direction, setDirection] = useState(1);
  const [riskTier, setRiskTier] = useState<EarnRiskTier | null>(initialStrategy?.riskTier ?? null);
  const [curatorFilter, setCuratorFilter] = useState<string | null>(null);
  const [strategyId, setStrategyId] = useState<string | null>(initialStrategy?.id ?? null);
  const [walletId, setWalletId] = useState<string>(MOCK_EARN_WALLETS[0]?.id ?? "");
  const [tokenMint, setTokenMint] = useState<string>(initialStrategy?.depositMints[0] ?? "");
  const [amountInput, setAmountInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  const currentStepId = STEP_IDS[step] ?? "profile";
  const strategy = strategyId ? getMockStrategy(strategyId) : undefined;
  const wallet = MOCK_EARN_WALLETS.find((candidate) => candidate.id === walletId);
  const amount = Number(amountInput);
  const balance = wallet?.balances[tokenMint] ?? 0;
  const amountValid = Number.isFinite(amount) && amount > 0 && amount <= balance;

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
    strategy: strategy !== undefined,
    amount: amountValid && wallet !== undefined,
    review: true,
  };
  const canContinue = stepReady[currentStepId];

  const selectStrategy = (candidate: MockEarnStrategy) => {
    setStrategyId(candidate.id);
    if (!candidate.depositMints.includes(tokenMint)) {
      setTokenMint(candidate.depositMints[0] ?? "");
    }
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
    if (!strategy || !wallet || !amountValid) return;
    setSubmitting(true);
    // Design preview only: a short beat so confirmation feels real, then the
    // mock position lands locally.
    window.setTimeout(() => {
      addMockPosition({
        strategyId: strategy.id,
        walletId: wallet.id,
        tokenMint,
        amount,
      });
      setSubmitting(false);
      setConfirmed(true);
    }, 650);
  };

  if (confirmed && strategy) {
    return <SuccessPanel strategy={strategy} amount={amount} tokenMint={tokenMint} />;
  }

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
            onClick={step === 0 ? () => router.push("/dashboard/earn") : goBack}
            iconLeft={step === 0 ? undefined : <ArrowLeftIcon />}
          >
            {step === 0 ? t("DashboardEarn.wizard.cancel") : t("DashboardEarn.wizard.back")}
          </Button>
          {currentStepId === "review" ? (
            <Button
              type="button"
              onClick={submit}
              disabled={submitting || !canContinue}
              iconLeft={submitting ? <Loader2Icon className="animate-spin" /> : undefined}
            >
              {submitting
                ? t("DashboardEarn.wizard.confirming")
                : t("DashboardEarn.wizard.confirm")}
            </Button>
          ) : (
            <Button
              type="button"
              onClick={goNext}
              disabled={!canContinue}
              iconRight={<ArrowRightIcon />}
            >
              {t("DashboardEarn.wizard.next")}
            </Button>
          )}
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
              {currentStepId === "profile" ? (
                <ProfileStep riskTier={riskTier} onSelect={setRiskTier} />
              ) : null}
              {currentStepId === "strategy" ? (
                <StrategyStep
                  choices={strategyChoices}
                  curators={curators}
                  curatorFilter={curatorFilter}
                  strategyId={strategyId}
                  onCuratorFilter={setCuratorFilter}
                  onSelect={selectStrategy}
                />
              ) : null}
              {currentStepId === "amount" && strategy ? (
                <AmountStep
                  strategy={strategy}
                  walletId={walletId}
                  tokenMint={tokenMint}
                  amountInput={amountInput}
                  amount={amount}
                  amountValid={amountValid}
                  balance={balance}
                  onWalletChange={setWalletId}
                  onTokenChange={setTokenMint}
                  onAmountChange={setAmountInput}
                />
              ) : null}
              {currentStepId === "review" && strategy && wallet ? (
                <ReviewStep
                  strategy={strategy}
                  wallet={wallet}
                  amount={amount}
                  tokenMint={tokenMint}
                />
              ) : null}
            </motion.div>
          </AnimatePresence>
        </div>

        <SummaryRail
          riskTier={riskTier}
          strategy={strategy}
          wallet={wallet}
          amount={amount}
          amountValid={amountValid}
          tokenMint={tokenMint}
          showFunding={step >= 2}
        />
      </div>
    </PaymentsWizardFrame>
  );
}
