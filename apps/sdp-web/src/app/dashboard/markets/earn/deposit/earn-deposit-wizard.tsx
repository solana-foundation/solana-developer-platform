"use client";

import type { EarnPortfolioAllocationInput, EarnStrategy } from "@sdp/types";
import { ArrowLeftIcon, ArrowRightIcon, Loader2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { WizardFrame } from "@/components/wizard-frame";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { formatApy } from "../earn-format";
import {
  createEarnProgram,
  EARN_PORTFOLIO_PROVIDER,
  type EarnProgramWriteInput,
  findProgram,
  retargetEarnProgram,
  useEarnPrograms,
  useEarnStrategies,
} from "../earn-program-data";
import { strategyToken, useLiquidityLabel } from "../earn-program-presentation";
import { EarnDepositSkeleton } from "../earn-route-skeletons";
import { SummaryRow } from "./earn-deposit-chrome";
import {
  availableTokens,
  rankedStrategies,
  singleStrategyAllocation,
  strategyDepositEligibility,
} from "./earn-deposit-model";
import { useEarnFundingWallets, walletDisplayName } from "./earn-funding-wallets";
import { type EarnApiKeyView, IntegrationScreen } from "./integration-screen";
import { ProgramLiveScreen } from "./program-live-screen";
import { ReviewStep } from "./review-step";
import { StrategyStep } from "./strategy-step";
import { WalletStep } from "./wallet-step";

const CREATE_STEPS = ["wallet", "strategy", "review"] as const;
/** A change-strategy run moves no funds, so it never asks for a wallet. */
const UPDATE_STEPS = ["strategy", "review"] as const;
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
        programId={outcome.programId}
        withdrawalToken={strategyToken(strategy) ?? "usdc"}
      />
    );
  }

  return (
    <ProgramLiveScreen
      created={outcome.created}
      fundingWalletLabel={fundingWalletLabel}
      onDone={onDone}
      programId={outcome.programId}
      strategy={strategy}
    />
  );
}

/**
 * Which verb this run performs. Decided by the URL, never inferred from the
 * response — an explicit create that reported "not created" would be a
 * contradiction.
 */
function writeProgram(retargetProgramId: string | undefined, input: EarnProgramWriteInput) {
  return retargetProgramId
    ? retargetEarnProgram(retargetProgramId, input)
    : createEarnProgram(input);
}

/**
 * Idempotency key for the confirm, minted lazily and held per selected
 * strategy: a retry after a failed confirm replays the SAME key so the provider
 * cannot apply the change twice, while switching strategy mints a fresh one —
 * reusing a key with a different payload is a provider conflict.
 *
 * A ref, not state: re-rendering must never mint a new key for an unchanged
 * selection, which is exactly the double-submit this guards against.
 */
function useStrategyRequestId() {
  const requestIdRef = useRef<{ strategyId: string; requestId: string } | null>(null);
  return (strategyId: string): string => {
    if (requestIdRef.current?.strategyId !== strategyId) {
      requestIdRef.current = { strategyId, requestId: crypto.randomUUID() };
    }
    return requestIdRef.current.requestId;
  };
}

/**
 * Land every step and outcome transition already scrolled to the top with its
 * heading focused, so a screen-reader user hears the new screen and a sighted
 * one never sees the previous screen's scroll offset.
 */
function useWizardStepFocus(step: DepositStep, outcome: Outcome | null) {
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
}

/** Full-screen stop state: one message, one action. */
function WizardNotice({
  actionLabel,
  message,
  onAction,
}: {
  actionLabel: string;
  message: string;
  onAction: () => void;
}) {
  return (
    <div className="mx-auto mt-16 flex max-w-md flex-col items-center gap-4 rounded-xl border border-border-default bg-surface-raised p-8 text-center">
      <p className="text-sm leading-6 text-secondary">{message}</p>
      <Button onClick={onAction} type="button" variant="secondary">
        {actionLabel}
      </Button>
    </div>
  );
}

function primaryActionLabel({
  retargeting,
  step,
  stepReady,
  submitting,
  t,
}: {
  retargeting: boolean;
  step: DepositStep;
  stepReady: Record<DepositStep, boolean>;
  submitting: boolean;
  t: ReturnType<typeof useTranslations>;
}): string {
  if (submitting) return t("DashboardEarn.deposit.confirming");
  if (step === "review") {
    return t(
      retargeting ? "DashboardEarn.deposit.confirmUpdate" : "DashboardEarn.deposit.confirmCreate"
    );
  }
  return stepReady[step] ? t("DashboardEarn.deposit.continueAction") : t(STEP_PENDING_LABEL[step]);
}

/**
 * What the flow shows once the program is written. `programId` names the exact
 * program that was just created or re-targeted — the live screen reads its
 * deposit feed by it, and the API snippets print it, so neither may fall back to
 * "whichever program is first".
 */
type Outcome =
  | {
      screen: "integration";
      created: boolean;
      allocations: EarnPortfolioAllocationInput;
      programId: string;
    }
  | { screen: "live"; created: boolean; programId: string };

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
   * straight onto one.
   */
  initialStrategyId?: string;
  /**
   * Which existing program this run re-targets, from `?program=`; absent means
   * "add a new one". Resolved by the server shell like `strategy` — search
   * params belong to page.tsx, the wizard receives props.
   */
  retargetProgramId?: string;
}

export function EarnDepositWizard({
  apiBaseUrl,
  apiKeys,
  fireblocksEnabled,
  initialStrategyId,
  retargetProgramId,
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
  const { state: programState, error: programsError, refresh: refreshProgram } = useEarnPrograms();

  // The table is a catalogue, not an eligibility filter: show every active
  // strategy so a sandbox reader can compare the real Kamino shelf too.
  // Selection stays guarded independently below.
  const activeStrategies = useMemo(
    () => (catalogue ?? []).filter((strategy) => strategy.status === "active"),
    [catalogue]
  );

  const [rawStep, setStep] = useState<DepositStep>("wallet");
  /**
   * Session-only: nothing persists the funding wallet, so a later visit asks
   * again. It shapes the funding instructions; it never moves money.
   */
  const [walletId, setWalletId] = useState<string | null>(null);
  const [strategyId, setStrategyId] = useState<string | null>(initialStrategyId ?? null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const tokens = useMemo(() => availableTokens(activeStrategies), [activeStrategies]);
  const browsable = useMemo(() => rankedStrategies(activeStrategies), [activeStrategies]);

  const selectedWallet = (wallets ?? []).find((wallet) => wallet.id === walletId);
  const selectedCatalogueStrategy: EarnStrategy | undefined = browsable.find(
    (strategy) => strategy.id === strategyId
  );
  // Defence beyond the disabled radio: a `?strategy=` deep link or a catalogue
  // revalidation must not carry an ineligible row into review.
  const selectedStrategy =
    selectedCatalogueStrategy &&
    strategyDepositEligibility(selectedCatalogueStrategy, EARN_PORTFOLIO_PROVIDER) === "eligible"
      ? selectedCatalogueStrategy
      : undefined;

  const selectStrategy = (candidateId: string) => {
    const candidate = browsable.find((strategy) => strategy.id === candidateId);
    if (
      candidate &&
      strategyDepositEligibility(candidate, EARN_PORTFOLIO_PROVIDER) === "eligible"
    ) {
      setStrategyId(candidate.id);
    }
  };

  /**
   * The run's shape comes from the URL, not from whether the organization
   * happens to hold a program.
   *
   * With several programs legal, "a program exists" no longer tells this flow
   * what the user asked for: adding a second strategy and re-targeting the
   * first are different intents that look identical from that boolean. A
   * `?program=<id>` on the deposit route says which one, and its absence means
   * "add a new one" — so the choice is addressable, shareable, and survives a
   * reload. An id that does NOT resolve is an error screen, never a fallback:
   * silently downgrading "change this program's strategy" to "create a new
   * program" would provision a second funded wallet the user did not ask for.
   */
  const retargetProgram = findProgram(programState, retargetProgramId);
  const retargeting = retargetProgram !== undefined;
  const providerUnconfigured = programState?.kind === "unconfigured";

  // `rawStep` starts at "wallet" before the program read resolves; on a
  // re-target run that maps onto the first real step instead.
  const stepOrder: readonly DepositStep[] = retargeting ? UPDATE_STEPS : CREATE_STEPS;
  const step: DepositStep = retargeting && rawStep === "wallet" ? "strategy" : rawStep;

  const requestIdFor = useStrategyRequestId();

  const stepReady: Record<DepositStep, boolean> = {
    wallet: walletId !== null,
    strategy: selectedStrategy !== undefined,
    review: selectedStrategy !== undefined && !providerUnconfigured && !submitting,
  };

  useWizardStepFocus(step, outcome);

  const confirm = async () => {
    if (!selectedStrategy || !stepReady.review) return;
    const allocations = singleStrategyAllocation(selectedStrategy);
    if (!allocations) return;

    setSubmitting(true);
    setSubmitError(null);
    const result = await writeProgram(retargetProgram?.id, {
      allocations,
      requestId: requestIdFor(selectedStrategy.id),
    });
    setSubmitting(false);
    if (!result.ok) {
      setSubmitError(result.error);
      return;
    }

    refreshProgram();
    const created = retargetProgram === undefined;
    const programId = result.data.data.program.id;
    // API integrators get the integration screen first; everyone else goes
    // straight to the live program.
    setOutcome(
      apiKeys.length > 0 && apiBaseUrl
        ? { screen: "integration", created, allocations, programId }
        : { screen: "live", created, programId }
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

  // A failed programs read must not strand the reader on an endless skeleton:
  // state stays undefined on error, and unlike the workspace this route had no
  // error surface at all. Same copy, same retry verb.
  if (programsError) {
    return (
      <WizardNotice
        actionLabel={t("Shared.SharedComponents.retry")}
        message={t("DashboardEarn.overview.programLoadError")}
        onAction={refreshProgram}
      />
    );
  }

  if (programState === undefined) {
    return <EarnDepositSkeleton />;
  }

  // The link asked to re-target a specific program and the resolved list does
  // not contain it (stale id, or another session removed it). Refusing beats
  // the silent downgrade to a create run — see the run-shape comment above.
  if (retargetProgramId !== undefined && retargetProgram === undefined) {
    return (
      <WizardNotice
        actionLabel={t("DashboardEarn.deposit.programMissingAction")}
        message={t("DashboardEarn.deposit.programMissing")}
        onAction={() => router.push(EARN_DASHBOARD_PATH)}
      />
    );
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
        onIntegrationDone={() =>
          setOutcome({ screen: "live", created: outcome.created, programId: outcome.programId })
        }
        outcome={outcome}
        strategy={selectedStrategy}
      />
    );
  }

  const currentStep = stepOrder.indexOf(step);
  const primaryLabel = primaryActionLabel({ retargeting, step, stepReady, submitting, t });

  /**
   * One element per step, looked up rather than branched through in the render.
   * Building all three is free — they are plain elements, and only the looked-up
   * one is ever mounted.
   */
  const stepBody: Record<DepositStep, ReactNode> = {
    wallet: (
      <WalletStep
        fireblocksEnabled={fireblocksEnabled}
        hasError={Boolean(walletsError)}
        isLoading={walletsLoading}
        onSelect={setWalletId}
        selectedWalletId={walletId}
        wallets={wallets ?? []}
      />
    ),
    strategy: (
      <StrategyStep
        hasError={Boolean(catalogueError)}
        isLoading={catalogueLoading}
        onSelect={selectStrategy}
        portfolioProvider={EARN_PORTFOLIO_PROVIDER}
        selectedStrategyId={selectedStrategy?.id ?? null}
        strategies={browsable}
        tokens={tokens}
      />
    ),
    review: selectedStrategy ? (
      <ReviewStep
        onEditStrategy={() => setStep("strategy")}
        onEditWallet={() => setStep("wallet")}
        programExists={retargeting}
        providerUnconfigured={providerUnconfigured}
        strategy={selectedStrategy}
        submitError={submitError}
        wallet={selectedWallet}
      />
    ) : null,
  };

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
          {retargeting ? null : (
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
      <div className="min-h-[24rem]">{stepBody[step]}</div>
    </WizardFrame>
  );
}
