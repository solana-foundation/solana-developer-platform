"use client";

import type { EarnPortfolioAllocationInput, EarnStrategy } from "@sdp/types";
import { ArrowLeftIcon, ArrowRightIcon, Loader2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { WizardFrame } from "@/components/wizard-frame";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { formatApy } from "../earn-format";
import {
  EARN_PORTFOLIO_PROVIDER,
  upsertEarnProgram,
  useEarnProgram,
  useEarnStrategies,
} from "../earn-program-data";
import { strategyToken, useLiquidityLabel } from "../earn-program-presentation";
import { EarnDepositSkeleton } from "../earn-route-skeletons";
import { SummaryRow } from "./earn-deposit-chrome";
import {
  availableTokens,
  type EarnDepositProfile,
  type EarnStrategyFilters,
  profileFilters,
  profileSummaries,
  singleStrategyAllocation,
  visibleStrategies,
} from "./earn-deposit-model";
import { useEarnFundingWallets, walletDisplayName } from "./earn-funding-wallets";
import { type EarnApiKeyView, IntegrationScreen } from "./integration-screen";
import { ProfileStep } from "./profile-step";
import { ProgramLiveScreen } from "./program-live-screen";
import { ReviewStep } from "./review-step";
import { StrategyStep } from "./strategy-step";
import { WalletStep } from "./wallet-step";

const CREATE_STEPS = ["wallet", "profile", "strategy", "review"] as const;
/** A change-strategy run moves no funds, so it never asks for a wallet. */
const UPDATE_STEPS = ["profile", "strategy", "review"] as const;
type DepositStep = (typeof CREATE_STEPS)[number];

const STEP_META: Record<
  DepositStep,
  { label: MessageKey; title: MessageKey; description: MessageKey }
> = {
  wallet: {
    label: "DashboardEarn.deposit.progressWallet",
    title: "DashboardEarn.deposit.walletTitle",
    description: "DashboardEarn.deposit.walletDescription",
  },
  profile: {
    label: "DashboardEarn.deposit.progressProfile",
    title: "DashboardEarn.deposit.profileTitle",
    description: "DashboardEarn.deposit.profileDescription",
  },
  strategy: {
    label: "DashboardEarn.deposit.progressStrategy",
    title: "DashboardEarn.deposit.strategyTitle",
    description: "DashboardEarn.deposit.strategyDescription",
  },
  review: {
    label: "DashboardEarn.deposit.progressReview",
    title: "DashboardEarn.deposit.reviewTitle",
    description: "DashboardEarn.deposit.reviewDescription",
  },
};

const EARN_DASHBOARD_PATH = "/dashboard/markets/earn";

/**
 * Copy naming what a step still needs, so a disabled button is never mute.
 * Review is absent on purpose: its label is always the confirm verb, chosen by
 * whether a program already exists rather than by readiness.
 */
const STEP_PENDING_LABEL: Record<Exclude<DepositStep, "review">, MessageKey> = {
  wallet: "DashboardEarn.deposit.selectWallet",
  profile: "DashboardEarn.deposit.selectProfile",
  strategy: "DashboardEarn.deposit.selectStrategy",
};

/**
 * Post-confirm screens. The program is already written at this point, so this
 * only chooses between the optional API-integration hand-off and the live
 * program view.
 */
function DepositOutcome({
  apiBaseUrl,
  apiKeys,
  fundingWalletLabel,
  onDone,
  onIntegrationDone,
  outcome,
  strategy,
}: {
  apiBaseUrl: string | null;
  apiKeys: readonly EarnApiKeyView[];
  fundingWalletLabel: string | undefined;
  onDone: () => void;
  onIntegrationDone: () => void;
  outcome: Outcome;
  strategy: EarnStrategy;
}) {
  if (outcome.screen === "integration" && apiBaseUrl) {
    return (
      <IntegrationScreen
        allocations={outcome.allocations}
        apiBaseUrl={apiBaseUrl}
        apiKeys={apiKeys}
        onDone={onIntegrationDone}
        provider={EARN_PORTFOLIO_PROVIDER}
        withdrawalToken={strategyToken(strategy) ?? "usdc"}
      />
    );
  }

  return (
    <ProgramLiveScreen
      created={outcome.created}
      fundingWalletLabel={fundingWalletLabel}
      onDone={onDone}
      strategy={strategy}
    />
  );
}

function primaryActionLabel({
  programExists,
  step,
  stepReady,
  submitting,
  t,
}: {
  programExists: boolean;
  step: DepositStep;
  stepReady: Record<DepositStep, boolean>;
  submitting: boolean;
  t: ReturnType<typeof useTranslations>;
}): string {
  if (submitting) return t("DashboardEarn.deposit.confirming");
  if (step === "review") {
    return t(
      programExists ? "DashboardEarn.deposit.confirmUpdate" : "DashboardEarn.deposit.confirmCreate"
    );
  }
  return stepReady[step] ? t("DashboardEarn.deposit.continueAction") : t(STEP_PENDING_LABEL[step]);
}

/** What the flow shows once the program is written. */
type Outcome =
  | { screen: "integration"; created: boolean; allocations: EarnPortfolioAllocationInput }
  | { screen: "live"; created: boolean };

export interface EarnDepositWizardProps {
  /**
   * Active API keys for the organization, resolved server-side. Their presence
   * is what makes this org an API integrator — the honest available signal for
   * the conditional integration step, since SDP persists no organization type.
   * An empty list simply skips that screen.
   */
  apiKeys: readonly EarnApiKeyView[];
  apiBaseUrl: string | null;
  /** Whether the org may actually provision a Fireblocks wallet today. */
  fireblocksEnabled: boolean;
  /**
   * Preselects a strategy from `?strategy=`, so a link can drop the reader
   * straight onto one. Kept deliberately: it is the flow's only deep-link entry.
   */
  initialStrategyId?: string;
}

export function EarnDepositWizard({
  apiBaseUrl,
  apiKeys,
  fireblocksEnabled,
  initialStrategyId,
}: EarnDepositWizardProps) {
  const t = useTranslations();
  const router = useRouter();
  const liquidityLabel = useLiquidityLabel();

  const {
    strategies: catalogue,
    error: catalogueError,
    isLoading: catalogueLoading,
  } = useEarnStrategies();
  const { wallets, error: walletsError, isLoading: walletsLoading } = useEarnFundingWallets();
  const { state: programState, refresh: refreshProgram } = useEarnProgram();

  // The PUT validates yield sources against the pinned provider's active
  // catalogue, so the flow only ever offers those rows.
  const liveStrategies = useMemo(
    () =>
      (catalogue ?? []).filter(
        (strategy) => strategy.provider === EARN_PORTFOLIO_PROVIDER && strategy.status === "active"
      ),
    [catalogue]
  );

  const [rawStep, setStep] = useState<DepositStep>("wallet");
  /**
   * Session-only: nothing persists the funding wallet, so a later visit asks
   * again. It shapes the funding instructions; it never moves money.
   */
  const [walletId, setWalletId] = useState<string | null>(null);
  const [profile, setProfile] = useState<EarnDepositProfile | null>(null);
  const [filters, setFilters] = useState<EarnStrategyFilters | null>(null);
  const [strategyId, setStrategyId] = useState<string | null>(initialStrategyId ?? null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const summaries = useMemo(() => profileSummaries(liveStrategies), [liveStrategies]);
  const tokens = useMemo(() => availableTokens(liveStrategies), [liveStrategies]);
  const activeFilters = filters ?? profileFilters(profile ?? "balanced");
  const browsable = useMemo(
    () => visibleStrategies(liveStrategies, activeFilters),
    [activeFilters, liveStrategies]
  );

  const selectedWallet = (wallets ?? []).find((wallet) => wallet.id === walletId);
  const selectedStrategy: EarnStrategy | undefined = liveStrategies.find(
    (strategy) => strategy.id === strategyId
  );

  const programExists = programState?.kind === "active";
  const providerUnconfigured = programState?.kind === "unconfigured";

  // The run's shape. `rawStep` starts at "wallet" before the program read
  // resolves; on an update run that maps onto the first real step instead.
  const stepOrder: readonly DepositStep[] = programExists ? UPDATE_STEPS : CREATE_STEPS;
  const step: DepositStep = programExists && rawStep === "wallet" ? "profile" : rawStep;

  /**
   * Idempotency key for the confirm, minted lazily and held per selected
   * strategy: a retry after a failed confirm replays the SAME key so the
   * provider cannot apply the change twice, while switching strategy mints a
   * fresh one — reusing a key with a different payload is a provider conflict.
   */
  const requestIdRef = useRef<{ strategyId: string; requestId: string } | null>(null);
  const requestIdFor = (id: string): string => {
    if (requestIdRef.current?.strategyId !== id) {
      requestIdRef.current = { strategyId: id, requestId: crypto.randomUUID() };
    }
    return requestIdRef.current.requestId;
  };

  const stepReady: Record<DepositStep, boolean> = {
    wallet: walletId !== null,
    profile: profile !== null,
    strategy: selectedStrategy !== undefined,
    review: selectedStrategy !== undefined && !providerUnconfigured && !submitting,
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: Every step and outcome transition must land already scrolled to the top with its heading announced.
  useLayoutEffect(() => {
    // Pre-paint so the new screen's first frame is already at the top — no
    // visible jump or smooth-scroll drift after the content appears.
    const scrollRegion = document.querySelector<HTMLElement>(
      outcome ? "[data-earn-outcome-scroll]" : "[data-wizard-scroll-region]"
    );
    if (!scrollRegion) return;

    scrollRegion.scrollTo({ top: 0, behavior: "instant" });
    const heading = scrollRegion.querySelector<HTMLHeadingElement>("h2");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  }, [step, outcome]);

  /**
   * Choosing a profile reseeds the browse filters and drops a selection the new
   * filters would hide, so the review step can never confirm a strategy the
   * user can no longer see.
   */
  const chooseProfile = (next: EarnDepositProfile) => {
    setProfile(next);
    const nextFilters = profileFilters(next);
    setFilters(nextFilters);
    if (
      strategyId !== null &&
      !visibleStrategies(liveStrategies, nextFilters).some((strategy) => strategy.id === strategyId)
    ) {
      setStrategyId(null);
    }
  };

  const confirm = async () => {
    if (!selectedStrategy || !stepReady.review) return;
    const allocations = singleStrategyAllocation(selectedStrategy);
    if (!allocations) return;

    setSubmitting(true);
    setSubmitError(null);
    const result = await upsertEarnProgram({
      allocations,
      requestId: requestIdFor(selectedStrategy.id),
    });
    setSubmitting(false);
    if (!result.ok) {
      setSubmitError(result.error);
      return;
    }

    refreshProgram();
    const created = result.data.data.created;
    // API integrators get the integration screen first; everyone else goes
    // straight to the live program.
    setOutcome(
      apiKeys.length > 0 && apiBaseUrl
        ? { screen: "integration", created, allocations }
        : { screen: "live", created }
    );
  };

  const goNext = () => {
    if (step === "review") {
      void confirm();
      return;
    }
    if (!stepReady[step]) return;
    const index = stepOrder.indexOf(step);
    setStep(stepOrder[index + 1] ?? "review");
  };

  const goBack = () => {
    const index = stepOrder.indexOf(step);
    if (index <= 0) {
      router.push(EARN_DASHBOARD_PATH);
      return;
    }
    setStep(stepOrder[index - 1] ?? stepOrder[0]);
  };

  if (programState === undefined) {
    return <EarnDepositSkeleton />;
  }

  if (outcome && selectedStrategy) {
    return (
      <DepositOutcome
        apiBaseUrl={apiBaseUrl}
        apiKeys={apiKeys}
        fundingWalletLabel={
          selectedWallet
            ? walletDisplayName(selectedWallet, t("DashboardEarn.deposit.walletUnnamed"))
            : undefined
        }
        onDone={() => router.push(EARN_DASHBOARD_PATH)}
        onIntegrationDone={() => setOutcome({ screen: "live", created: outcome.created })}
        outcome={outcome}
        strategy={selectedStrategy}
      />
    );
  }

  const currentStep = stepOrder.indexOf(step);
  const primaryLabel = primaryActionLabel({ programExists, step, stepReady, submitting, t });

  return (
    <WizardFrame
      currentStep={currentStep}
      description={t(STEP_META[step].description)}
      footer={
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between [&>button]:w-full sm:[&>button]:w-auto">
          <Button
            disabled={submitting}
            iconLeft={stepOrder.indexOf(step) === 0 ? undefined : <ArrowLeftIcon />}
            onClick={goBack}
            type="button"
            variant="secondary"
          >
            {t(
              stepOrder.indexOf(step) === 0
                ? "DashboardEarn.deposit.cancel"
                : "DashboardEarn.deposit.back"
            )}
          </Button>
          <Button
            disabled={!stepReady[step]}
            iconLeft={
              submitting ? (
                <Loader2Icon className="animate-spin motion-reduce:animate-none" />
              ) : undefined
            }
            iconRight={step === "review" || submitting ? undefined : <ArrowRightIcon />}
            onClick={goNext}
            type="button"
          >
            {primaryLabel}
          </Button>
        </div>
      }
      maxWidthClassName="max-w-4xl"
      progressLabel={t("DashboardEarn.deposit.stepProgress", {
        current: currentStep + 1,
        total: stepOrder.length,
      })}
      steps={stepOrder.map((entry) => ({
        label: t(STEP_META[entry].label),
        title: t(STEP_META[entry].title),
      }))}
      summary={
        <div>
          <h3 className="mb-2 text-sm font-medium text-primary">
            {t("DashboardEarn.deposit.summaryTitle")}
          </h3>
          {programExists ? null : (
            <SummaryRow
              label={t("DashboardEarn.deposit.reviewWallet")}
              value={
                selectedWallet
                  ? walletDisplayName(selectedWallet, t("DashboardEarn.deposit.walletUnnamed"))
                  : t("DashboardEarn.deposit.notSelected")
              }
            />
          )}
          <SummaryRow
            label={t("DashboardEarn.deposit.reviewStrategy")}
            value={selectedStrategy?.name ?? t("DashboardEarn.deposit.notSelected")}
          />
          <SummaryRow
            label={t("DashboardEarn.deposit.reviewApy")}
            value={
              selectedStrategy
                ? formatApy(selectedStrategy.currentApy)
                : t("DashboardEarn.deposit.notSelected")
            }
          />
          <SummaryRow
            label={t("DashboardEarn.deposit.reviewAccess")}
            value={
              selectedStrategy
                ? liquidityLabel(selectedStrategy)
                : t("DashboardEarn.deposit.notSelected")
            }
          />
        </div>
      }
    >
      {/* Steps swap instantly: each must land pre-scrolled to the top with no
          transition (see the useLayoutEffect scroll reset above). */}
      <div className="min-h-[24rem]">
        {step === "wallet" ? (
          <WalletStep
            fireblocksEnabled={fireblocksEnabled}
            hasError={Boolean(walletsError)}
            isLoading={walletsLoading}
            onSelect={setWalletId}
            selectedWalletId={walletId}
            wallets={wallets ?? []}
          />
        ) : null}

        {step === "profile" ? (
          <ProfileStep
            hasError={Boolean(catalogueError)}
            isLoading={catalogueLoading}
            onSelect={chooseProfile}
            selectedProfile={profile}
            summaries={summaries}
          />
        ) : null}

        {step === "strategy" ? (
          <StrategyStep
            filters={activeFilters}
            hasError={Boolean(catalogueError)}
            isLoading={catalogueLoading}
            onFiltersChange={setFilters}
            onReset={() => setFilters(profileFilters(profile ?? "balanced"))}
            onSelect={setStrategyId}
            selectedStrategyId={strategyId}
            strategies={browsable}
            tokens={tokens}
          />
        ) : null}

        {step === "review" && selectedStrategy ? (
          <ReviewStep
            onEditStrategy={() => setStep("strategy")}
            onEditWallet={() => setStep("wallet")}
            programExists={programExists}
            providerUnconfigured={providerUnconfigured}
            strategy={selectedStrategy}
            submitError={submitError}
            wallet={selectedWallet}
          />
        ) : null}
      </div>
    </WizardFrame>
  );
}
