"use client";

import {
  CLUSTER_BY_SDP_ENVIRONMENT,
  type EarnVaultPosition,
  earnWithdrawSlippageFloor,
  type SdpEnvironment,
} from "@sdp/types";
import { ExternalLinkIcon, Loader2Icon } from "lucide-react";
import { type ChangeEvent, useEffect, useRef, useState } from "react";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { useLocale, useTranslations } from "@/i18n/provider";
import { explorerTxUrl } from "@/lib/explorer";
import { applyIdempotencyKeyOutcome, resolveHeldIdempotencyKey } from "@/lib/idempotency-key-store";
import { useModalFocus } from "@/lib/use-modal-focus";
import { compareUnsignedDecimals } from "./earn-decimal";
import {
  EarnFlowStepper,
  EarnFlowTransition,
  EarnOutcomeMark,
  EarnProcessingFrame,
} from "./earn-flow-motion";
import { formatTokenQuantity, formatUsd } from "./earn-format";
import { earnMintAsset, shortenMarketAddress } from "./earn-market-presentation";
import {
  createEarnVaultWithdrawal,
  type EarnVaultWithdrawal,
  type EarnVaultWithdrawalPreview,
  fetchEarnVaultWithdrawalPreview,
  fetchEarnVaultWithdrawalsByRequestId,
  useEarnVaultWithdrawalOutcome,
} from "./earn-program-data";
import {
  floorForTolerance,
  isSlippageExceededRefusal,
  isZeroQuote,
  parseSlippageToleranceBps,
  quoteForKey,
  useDebouncedVaultQuote,
  type VaultQuoteState,
} from "./earn-vault-slippage";
import { VaultSlippageSection } from "./earn-vault-slippage-section";
import { earnVaultPositionStatusDisplay, earnVaultWithdrawalUiState } from "./earn-vault-ui-state";
import {
  VAULT_WITHDRAWAL_AMOUNT_DECIMALS,
  validateVaultWithdrawalAmount,
  vaultWithdrawalAvailableAmount,
  vaultWithdrawalSharesForAmount,
} from "./earn-vault-withdraw-amount";
import {
  forgetVaultWithdrawalFloor,
  recallVaultWithdrawalFloor,
  rememberVaultWithdrawalFloor,
  vaultWithdrawalIdempotencyKeyStore,
  vaultWithdrawalRequestFingerprint,
} from "./earn-vault-withdraw-tracking";

/** The floor the current quote and tolerance imply, or `undefined` while they cannot. */
function derivedMinAmountOut(
  toleranceBps: number | null,
  quote: VaultQuoteState<EarnVaultWithdrawalPreview>
): string | undefined {
  if (toleranceBps === null || quote.kind !== "quoted") return undefined;
  if (quote.preview.blockingIssues.length > 0) return undefined;
  // `null` — a zero-asset quote — has no satisfiable floor; blocking the
  // submission is the only honest answer (see `floorForTolerance`).
  return (
    floorForTolerance(quote.preview.assetsOut, quote.preview.assetDecimals, toleranceBps) ??
    undefined
  );
}

/** Quote-state notices under the summary: loading, unavailable, or blocked. */
function WithdrawalQuoteNotices({ quote }: { quote: VaultQuoteState<EarnVaultWithdrawalPreview> }) {
  const t = useTranslations();
  if (quote.kind === "loading") {
    return (
      <p className="mt-2 text-xs text-tertiary" role="status">
        {t("DashboardEarn.vaultWithdraw.quoteLoading")}
      </p>
    );
  }
  if (quote.kind === "unavailable") {
    return (
      <p className="mt-2 text-xs text-error" role="alert">
        {t("DashboardEarn.vaultWithdraw.quoteUnavailable")}
      </p>
    );
  }
  const blockingIssue = quote.kind === "quoted" ? quote.preview.blockingIssues[0] : undefined;
  if (blockingIssue) {
    return (
      <p className="mt-2 text-xs text-error" role="alert">
        {t("DashboardEarn.vaultWithdraw.quoteBlocked", { message: blockingIssue.message })}
      </p>
    );
  }
  if (
    quote.kind === "quoted" &&
    isZeroQuote(quote.preview.assetsOut, quote.preview.assetDecimals)
  ) {
    return (
      <p className="mt-2 text-xs text-error" role="alert">
        {t("DashboardEarn.vaultWithdraw.quoteZeroAssets")}
      </p>
    );
  }
  return null;
}

function amountBalanceHint(
  t: ReturnType<typeof useTranslations>,
  locale: string,
  positionValue: string | undefined,
  availableAmount: string | undefined,
  hasStakedShares: boolean
): string {
  if (availableAmount === undefined) {
    return t("DashboardEarn.vaultWithdraw.amountUnavailable");
  }
  if (hasStakedShares && positionValue !== undefined) {
    return t("DashboardEarn.vaultWithdraw.amountAvailableOfTotal", {
      available: formatUsd(availableAmount, locale),
      total: formatUsd(positionValue, locale),
    });
  }
  return t("DashboardEarn.vaultWithdraw.amountAvailable", {
    amount: formatUsd(availableAmount, locale),
  });
}

type WithdrawalOutcome =
  | {
      kind: "approval_pending";
      approvalRequestId?: string;
      walletOperationId?: string;
    }
  | {
      kind: "withdrawal";
      withdrawal: EarnVaultWithdrawal;
      /**
       * The approval executor won the race between the held-key pre-flight and
       * this POST: real money DID move — once, via the approval — but THIS
       * submission moved nothing. Same rule as the deposit's absorbed case.
       */
      absorbedByApproval?: true;
    };

type WithdrawalSubmissionResolution =
  | { kind: "error"; message: string; slippageExceeded?: true }
  | { kind: "outcome"; outcome: WithdrawalOutcome; withdrawn?: EarnVaultWithdrawal };

function shouldProjectWithdrawalBalance(outcome: WithdrawalOutcome): boolean {
  return outcome.kind === "withdrawal" && !outcome.absorbedByApproval;
}

function resolveWithdrawalSubmission(
  result: Awaited<ReturnType<typeof createEarnVaultWithdrawal>>,
  fallbackError: string,
  keyWasHeld: boolean,
  slippageExceededMessage: string
): WithdrawalSubmissionResolution {
  if (!result.ok) {
    if (isSlippageExceededRefusal(result.body)) {
      return { kind: "error", message: slippageExceededMessage, slippageExceeded: true };
    }
    return { kind: "error", message: result.error || fallbackError };
  }
  if (result.data.kind === "approval_pending") {
    return {
      kind: "outcome",
      outcome: {
        kind: "approval_pending",
        ...(result.data.approvalRequestId
          ? { approvalRequestId: result.data.approvalRequestId }
          : {}),
        ...(result.data.walletOperationId
          ? { walletOperationId: result.data.walletOperationId }
          : {}),
      },
    };
  }

  const withdrawal = result.data.withdrawal;
  if (withdrawal.status === "failed") {
    return {
      kind: "error",
      message: withdrawal.failureReason || fallbackError,
    };
  }
  if (withdrawal.replayed && keyWasHeld) {
    return {
      kind: "outcome",
      outcome: { kind: "withdrawal", withdrawal, absorbedByApproval: true },
      withdrawn: withdrawal,
    };
  }
  return { kind: "outcome", outcome: { kind: "withdrawal", withdrawal }, withdrawn: withdrawal };
}

function observableWithdrawalMovementId(outcome: WithdrawalOutcome | null): string | undefined {
  if (outcome?.kind !== "withdrawal" || outcome.absorbedByApproval) return undefined;
  return outcome.withdrawal.movementId;
}

function mergeObservedWithdrawal(
  outcome: WithdrawalOutcome | null,
  observedWithdrawal: EarnVaultWithdrawal | undefined
): WithdrawalOutcome | null {
  if (outcome?.kind !== "withdrawal" || !observedWithdrawal) return outcome;
  return { ...outcome, withdrawal: { ...outcome.withdrawal, ...observedWithdrawal } };
}

function withdrawalProgressStep(
  outcome: WithdrawalOutcome | null,
  step: "details" | "review"
): number {
  if (!outcome) return step === "review" ? 1 : 0;
  if (outcome.kind !== "withdrawal" || outcome.absorbedByApproval) return 2;
  return earnVaultWithdrawalUiState(outcome.withdrawal.status).progressStep;
}

function withdrawalPanelKey(outcome: WithdrawalOutcome | null, step: "details" | "review"): string {
  if (!outcome) return `form:${step}`;
  if (outcome.kind === "approval_pending") return "outcome:approval";
  return outcome.absorbedByApproval ? "outcome:withdrawal:absorbed" : "outcome:withdrawal";
}

function deriveWithdrawalFormState(
  position: EarnVaultPosition,
  amountInput: string,
  slippagePolicy: ReturnType<typeof earnWithdrawSlippageFloor>,
  slippageInput: string,
  invalidAmountMessage: string
) {
  const amountValidation = validateVaultWithdrawalAmount(amountInput);
  const availableAmount = vaultWithdrawalAvailableAmount(position);
  const sharesToRedeem =
    amountValidation.kind === "valid"
      ? vaultWithdrawalSharesForAmount(amountValidation.canonicalAmount, position)
      : undefined;
  const hasStakedShares =
    position.shares !== undefined &&
    position.withdrawableShares !== undefined &&
    compareUnsignedDecimals(position.shares, position.withdrawableShares) === 1;
  const overAvailableAmount =
    amountValidation.kind === "valid" && availableAmount !== undefined
      ? compareUnsignedDecimals(amountValidation.canonicalAmount, availableAmount) === 1
      : false;
  const amountError =
    amountInput.trim() === "" || amountValidation.kind === "valid" ? null : invalidAmountMessage;
  const slippageBps = slippagePolicy ? parseSlippageToleranceBps(slippageInput) : null;
  const slippageInvalid = slippagePolicy !== null && slippageBps === null;
  const quoteShares =
    slippagePolicy !== null && sharesToRedeem !== undefined ? sharesToRedeem : null;
  const quoteKey = quoteShares === null ? null : JSON.stringify([position.id, quoteShares]);
  const continueBlocked =
    amountValidation.kind !== "valid" || sharesToRedeem === undefined || overAvailableAmount;

  return {
    amountError,
    amountValidation,
    availableAmount,
    continueBlocked,
    hasStakedShares,
    overAvailableAmount,
    quoteKey,
    quoteShares,
    sharesToRedeem,
    slippageBps,
    slippageInvalid,
  };
}

function TransactionLink({
  signature,
  environment,
}: {
  signature: string;
  environment: SdpEnvironment;
}) {
  const cluster = CLUSTER_BY_SDP_ENVIRONMENT[environment];

  return (
    <a
      className="inline-flex items-center gap-1 text-secondary underline decoration-border-strong underline-offset-4 transition-colors hover:text-primary"
      href={explorerTxUrl(signature, cluster)}
      rel="noreferrer"
      target="_blank"
    >
      {shortenMarketAddress(signature)}
      <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
    </a>
  );
}

function WithdrawalApprovalResult({
  outcome,
  onClose,
}: {
  outcome: Extract<WithdrawalOutcome, { kind: "approval_pending" }>;
  onClose: () => void;
}) {
  const t = useTranslations();

  return (
    <>
      <EarnOutcomeMark tone="warning" />
      <div className="flex items-center gap-2 pr-8">
        <h2
          className="text-base font-medium text-primary outline-none"
          data-modal-focus-target
          tabIndex={-1}
        >
          {t("DashboardEarn.vaultWithdraw.approvalTitle")}
        </h2>
        <Badge variant="warning">{t("DashboardEarn.vaultWithdraw.approvalStatus")}</Badge>
      </div>
      <p className="mt-2 text-sm leading-5 text-secondary">
        {t("DashboardEarn.vaultWithdraw.approvalBody")}
      </p>
      {outcome.approvalRequestId || outcome.walletOperationId ? (
        <dl className="mt-5 grid gap-3 rounded-xl bg-fill-subtle px-4 py-3 text-sm">
          {outcome.approvalRequestId ? (
            <div className="flex items-start justify-between gap-5">
              <dt className="text-tertiary">{t("DashboardEarn.deposit.vaultApprovalRequest")}</dt>
              <dd className="max-w-64 break-all text-right text-primary">
                {outcome.approvalRequestId}
              </dd>
            </div>
          ) : null}
          {outcome.walletOperationId ? (
            <div className="flex items-start justify-between gap-5">
              <dt className="text-tertiary">{t("DashboardEarn.withdraw.referenceLabel")}</dt>
              <dd className="max-w-64 break-all text-right text-primary">
                {outcome.walletOperationId}
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      <div className="mt-5 flex justify-end">
        <Button onClick={onClose}>{t("DashboardEarn.withdraw.done")}</Button>
      </div>
    </>
  );
}

interface WithdrawalResultCopy {
  body: string;
  note: string;
  status: string;
  statusVariant: BadgeVariant;
  title: string;
}

function withdrawalResultCopy(
  outcome: Extract<WithdrawalOutcome, { kind: "withdrawal" }>,
  t: ReturnType<typeof useTranslations>
): WithdrawalResultCopy {
  if (outcome.absorbedByApproval) {
    return {
      title: t("DashboardEarn.vaultWithdraw.absorbedTitle"),
      body: t("DashboardEarn.vaultWithdraw.absorbedBody"),
      note: t("DashboardEarn.vaultWithdraw.absorbedNote"),
      status: t("DashboardEarn.vaultWithdraw.absorbedStatus"),
      statusVariant: "info",
    };
  }
  switch (outcome.withdrawal.status) {
    case "requested":
      return {
        title: t("DashboardEarn.vaultWithdraw.recordedTitle"),
        body: t("DashboardEarn.vaultWithdraw.recordedBody"),
        note: t("DashboardEarn.vaultWithdraw.recordedNote"),
        status: t("DashboardEarn.vaultWithdraw.recordedStatus"),
        statusVariant: "warning",
      };
    case "confirmed":
      return {
        title: t("DashboardEarn.vaultWithdraw.confirmedTitle"),
        body: t("DashboardEarn.vaultWithdraw.confirmedBody"),
        note: t("DashboardEarn.vaultWithdraw.settlingNote"),
        status: t("DashboardEarn.vaultWithdraw.confirmedStatus"),
        statusVariant: "warning",
      };
    case "finalized":
      return {
        title: t("DashboardEarn.vaultWithdraw.finalizedTitle"),
        body: t("DashboardEarn.vaultWithdraw.finalizedBody"),
        note: t("DashboardEarn.vaultWithdraw.finalizedNote"),
        status: t("DashboardEarn.vaultWithdraw.finalizedStatus"),
        statusVariant: "success",
      };
    default:
      return {
        title: t("DashboardEarn.vaultWithdraw.submittedTitle"),
        body: t("DashboardEarn.vaultWithdraw.submittedBody"),
        note: t("DashboardEarn.vaultWithdraw.settlingNote"),
        status: t("DashboardEarn.vaultWithdraw.submittedStatus"),
        statusVariant: "default",
      };
  }
}

function outcomeTone(statusVariant: BadgeVariant): "info" | "success" | "warning" {
  if (statusVariant === "success") return "success";
  if (statusVariant === "warning") return "warning";
  return "info";
}

function WithdrawalMovementResult({
  outcome,
  environment,
  onClose,
  position,
  requestedAmount,
}: {
  outcome: Extract<WithdrawalOutcome, { kind: "withdrawal" }>;
  environment: SdpEnvironment;
  onClose: () => void;
  position: EarnVaultPosition;
  requestedAmount: string;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const asset = earnMintAsset(position.tokenMint);
  const positionName = position.label || shortenMarketAddress(position.providerReference);

  const { withdrawal } = outcome;
  const copy = withdrawalResultCopy(outcome, t);
  const sharedStatus = outcome.absorbedByApproval
    ? null
    : earnVaultPositionStatusDisplay(
        earnVaultWithdrawalUiState(withdrawal.status).positionStatus,
        t("DashboardMarkets.treasury.positionStatusPending"),
        t("DashboardMarkets.treasury.positionStatusActive")
      );
  const status = sharedStatus?.label ?? copy.status;
  const statusVariant: BadgeVariant = sharedStatus?.variant ?? copy.statusVariant;
  const processing =
    !outcome.absorbedByApproval &&
    (withdrawal.status === "requested" ||
      withdrawal.status === "submitted" ||
      withdrawal.status === "confirmed");

  return (
    <>
      {processing ? null : <EarnOutcomeMark tone={outcomeTone(statusVariant)} />}
      <div className="flex items-center gap-2 pr-8">
        <h2
          className="text-base font-medium text-primary outline-none"
          data-modal-focus-target
          tabIndex={-1}
        >
          {copy.title}
        </h2>
        <Badge variant={statusVariant}>{status}</Badge>
      </div>
      <p className="mt-2 text-sm leading-5 text-secondary">{copy.body}</p>

      <dl className="mt-5 grid gap-3 rounded-xl bg-fill-subtle px-4 py-3 text-sm">
        <div className="flex items-baseline justify-between gap-5">
          <dt className="text-tertiary">{t("DashboardEarn.deposit.vaultStrategy")}</dt>
          <dd className="max-w-64 text-right text-primary">{positionName}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-5">
          <dt className="text-tertiary">{t("DashboardEarn.vaultWithdraw.amountLabel")}</dt>
          <dd className="text-right tabular-nums text-primary">
            {formatUsd(requestedAmount, locale)}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-5">
          <dt className="text-tertiary">{t("DashboardEarn.vaultWithdraw.receiveAs")}</dt>
          <dd className="text-right text-primary">{asset.symbol}</dd>
        </div>
        {withdrawal.status === "requested" ? null : (
          <div className="flex items-baseline justify-between gap-5">
            <dt className="text-tertiary">{t("DashboardEarn.vaultWithdraw.transaction")}</dt>
            <dd className="text-right">
              <TransactionLink environment={environment} signature={withdrawal.signature} />
            </dd>
          </div>
        )}
      </dl>
      <p className="mt-4 text-xs leading-5 text-tertiary">{copy.note}</p>
      <div className="mt-5 flex justify-end">
        <Button onClick={onClose}>{t("DashboardEarn.withdraw.done")}</Button>
      </div>
    </>
  );
}

function WithdrawalResult({
  outcome,
  environment,
  onClose,
  position,
  requestedAmount,
}: {
  outcome: WithdrawalOutcome;
  environment: SdpEnvironment;
  onClose: () => void;
  position: EarnVaultPosition;
  requestedAmount: string;
}) {
  if (outcome.kind === "approval_pending") {
    return <WithdrawalApprovalResult onClose={onClose} outcome={outcome} />;
  }
  return (
    <WithdrawalMovementResult
      environment={environment}
      onClose={onClose}
      outcome={outcome}
      position={position}
      requestedAmount={requestedAmount}
    />
  );
}

interface EarnVaultWithdrawalOutcomeTrackerProps {
  movementId: string;
  /** Keep the table's status badge current while the movement advances. */
  onUpdated?: (withdrawal: EarnVaultWithdrawal) => void;
  /** Refresh the balances the exit changed, then retire the tracker. */
  onSettled?: (withdrawal: EarnVaultWithdrawal) => void;
}

/**
 * Keeps one logical withdrawal under observation independently of the
 * dismissible modal. The canonical hook polls the movement until the
 * internal transaction reaches a terminal result.
 */
export function EarnVaultWithdrawalOutcomeTracker({
  movementId,
  onSettled,
  onUpdated,
}: EarnVaultWithdrawalOutcomeTrackerProps) {
  useEarnVaultWithdrawalOutcome(movementId, onSettled, onUpdated);
  return null;
}

export interface EarnVaultWithdrawModalProps {
  position: EarnVaultPosition;
  environment: SdpEnvironment;
  /** Part of the request fingerprint — see `vaultWithdrawalRequestFingerprint`. */
  projectId: string | null;
  onClose: () => void;
  onWithdrawn?: (
    withdrawal: EarnVaultWithdrawal,
    intent: {
      amount: string;
      /** False when an approval already executed this replayed intent. */
      projectBalance: boolean;
    }
  ) => void;
  onMovementUpdated?: (withdrawal: EarnVaultWithdrawal) => void;
}

interface WithdrawalDetailsStepProps {
  amountError: string | null;
  amountInput: string;
  availableAmount: string | undefined;
  continueBlocked: boolean;
  hasStakedShares: boolean;
  onAmountChange: (value: string) => void;
  onContinue: () => void;
  onMax: () => void;
  overAvailableAmount: boolean;
  positionValue: string | undefined;
  submitting: boolean;
}

function WithdrawalDetailsStep(props: WithdrawalDetailsStepProps) {
  const {
    amountError,
    amountInput,
    availableAmount,
    continueBlocked,
    hasStakedShares,
    onAmountChange,
    onContinue,
    onMax,
    overAvailableAmount,
    positionValue,
    submitting,
  } = props;
  const locale = useLocale();
  const t = useTranslations();

  return (
    <>
      <div className="mt-5 flex flex-col gap-2">
        <div className="flex items-end justify-between gap-3">
          <Label htmlFor="earn-vault-withdraw-amount">
            {t("DashboardEarn.vaultWithdraw.amountLabel")}
          </Label>
          <Button
            disabled={submitting || availableAmount === undefined}
            onClick={onMax}
            size="sm"
            type="button"
            variant="ghost"
          >
            {t("DashboardEarn.vaultWithdraw.max")}
          </Button>
        </div>
        <Input
          aria-describedby="earn-vault-withdraw-balance"
          aria-invalid={amountError ? true : undefined}
          disabled={submitting}
          id="earn-vault-withdraw-amount"
          inputMode="decimal"
          leadingAddon={<span aria-hidden="true">$</span>}
          maxDecimals={VAULT_WITHDRAWAL_AMOUNT_DECIMALS}
          onChange={(event: ChangeEvent<HTMLInputElement>) => onAmountChange(event.target.value)}
          placeholder="0.00"
          value={amountInput}
        />
        <div className="min-h-5 text-xs text-tertiary" id="earn-vault-withdraw-balance">
          {amountBalanceHint(t, locale, positionValue, availableAmount, hasStakedShares)}
        </div>
        {amountError ? (
          <p className="text-xs text-error" role="alert">
            {amountError}
          </p>
        ) : null}
        {overAvailableAmount ? (
          <p className="text-xs text-warning" role="status">
            {t("DashboardEarn.vaultWithdraw.overAmount")}
          </p>
        ) : null}
      </div>

      <div className="mt-6">
        <Button className="!w-full" disabled={continueBlocked} onClick={onContinue}>
          {t("DashboardEarn.deposit.continueAction")}
        </Button>
      </div>
    </>
  );
}

interface WithdrawalReviewStepProps {
  amount: string;
  assetSymbol: string;
  minAmountOut: string | undefined;
  onBack: () => void;
  onSlippageChange: (value: string) => void;
  onSlippageToggle: () => void;
  onSubmit: () => void;
  position: EarnVaultPosition;
  quote: VaultQuoteState<EarnVaultWithdrawalPreview>;
  slippageBps: number | null;
  slippageInput: string;
  slippageInvalid: boolean;
  slippageOpen: boolean;
  slippagePolicy: ReturnType<typeof earnWithdrawSlippageFloor>;
  submitBlocked: boolean;
  submitError: string | null;
  submitting: boolean;
}

function WithdrawalReviewStep(props: WithdrawalReviewStepProps) {
  const {
    amount,
    assetSymbol,
    minAmountOut,
    onBack,
    onSlippageChange,
    onSlippageToggle,
    onSubmit,
    position,
    quote,
    slippageBps,
    slippageInput,
    slippageInvalid,
    slippageOpen,
    slippagePolicy,
    submitBlocked,
    submitError,
    submitting,
  } = props;
  const locale = useLocale();
  const t = useTranslations();

  return (
    <>
      <p className="mt-1 text-sm text-secondary">{t("DashboardEarn.deposit.progressReview")}</p>

      <dl className="mt-5 grid gap-3 rounded-xl bg-fill-subtle px-4 py-3 text-sm">
        <div className="flex items-baseline justify-between gap-5">
          <dt className="text-tertiary">{t("DashboardEarn.deposit.vaultStrategy")}</dt>
          <dd className="max-w-64 text-right text-primary">
            {position.label || shortenMarketAddress(position.providerReference)}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-5">
          <dt className="text-tertiary">{t("DashboardEarn.vaultWithdraw.amountLabel")}</dt>
          <dd className="text-right tabular-nums text-primary">{formatUsd(amount, locale)}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-5">
          <dt className="text-tertiary">{t("DashboardEarn.vaultWithdraw.receiveAs")}</dt>
          <dd className="text-right text-primary">{assetSymbol}</dd>
        </div>
        {quote.kind === "quoted" && quote.preview.blockingIssues.length === 0 ? (
          <div className="flex items-baseline justify-between gap-5">
            <dt className="text-tertiary">{t("DashboardEarn.vaultWithdraw.expectedAmount")}</dt>
            <dd className="text-right tabular-nums text-primary">
              {formatTokenQuantity(quote.preview.assetsOut, locale, assetSymbol)}
            </dd>
          </div>
        ) : null}
        {minAmountOut !== undefined ? (
          <div className="flex items-baseline justify-between gap-5">
            <dt className="text-tertiary">{t("DashboardEarn.vaultWithdraw.minAmount")}</dt>
            <dd className="text-right tabular-nums text-primary">
              {formatTokenQuantity(minAmountOut, locale, assetSymbol)}
            </dd>
          </div>
        ) : null}
      </dl>

      <WithdrawalQuoteNotices quote={quote} />

      {slippagePolicy ? (
        <VaultSlippageSection
          help={t("DashboardEarn.vaultWithdraw.slippageHelp")}
          idPrefix="earn-vault-withdraw"
          input={slippageInput}
          invalid={slippageInvalid}
          onChange={onSlippageChange}
          onToggle={onSlippageToggle}
          open={slippageOpen}
          submitting={submitting}
          toleranceBps={slippageBps}
        />
      ) : null}

      <p className="mt-4 text-xs leading-5 text-tertiary">
        {position.feeSponsored
          ? t("DashboardEarn.vaultWithdraw.confirmNoteSponsored")
          : t("DashboardEarn.vaultWithdraw.confirmNote")}
      </p>
      {submitError ? (
        <p
          className="mt-3 rounded-lg border border-destructive-border bg-destructive-bg p-3 text-sm text-error"
          role="alert"
        >
          {submitError}
        </p>
      ) : null}

      <div className="mt-6 flex gap-2">
        <Button className="flex-1" disabled={submitting} onClick={onBack} variant="outline">
          {t("DashboardEarn.deposit.back")}
        </Button>
        <Button
          className="flex-[2]"
          disabled={submitting || submitBlocked}
          iconLeft={submitting ? <Loader2Icon aria-hidden="true" className="animate-spin" /> : null}
          onClick={onSubmit}
        >
          {submitting
            ? t("DashboardEarn.vaultWithdraw.submitting")
            : t("DashboardEarn.vaultWithdraw.submit")}
        </Button>
      </div>
    </>
  );
}

/**
 * Exit a vault position using a stablecoin amount. The UI converts that amount
 * from the live position value into the exact share quantity the API requires,
 * then reviews the provider's payout quote before anything is submitted.
 */
export function EarnVaultWithdrawModal({
  position,
  environment,
  projectId,
  onClose,
  onWithdrawn,
  onMovementUpdated,
}: EarnVaultWithdrawModalProps) {
  const t = useTranslations();
  const [amountInput, setAmountInput] = useState("");
  // Declared per provider in @sdp/types: non-null means this provider REQUIRES
  // an explicit exit floor derived from a live quote. Null renders no slippage
  // control and sends no floor — Kamino's contract is unchanged.
  const slippagePolicy = earnWithdrawSlippageFloor(position.provider);
  const [slippageInput, setSlippageInput] = useState(() =>
    slippagePolicy ? String(slippagePolicy.defaultToleranceBps) : ""
  );
  const [slippageOpen, setSlippageOpen] = useState(false);
  const [step, setStep] = useState<"details" | "review">("details");
  const [quoteRefreshKey, setQuoteRefreshKey] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<WithdrawalOutcome | null>(null);
  const submittingRef = useRef(false);
  const requestControllerRef = useRef<AbortController | null>(null);
  const observedWithdrawal = useEarnVaultWithdrawalOutcome(
    observableWithdrawalMovementId(outcome),
    undefined,
    onMovementUpdated
  );
  const visibleOutcome = mergeObservedWithdrawal(outcome, observedWithdrawal);
  const progressStep = withdrawalProgressStep(visibleOutcome, step);
  const progressSteps = [
    t("DashboardEarn.vaultWithdraw.flowDetails"),
    t("DashboardEarn.vaultWithdraw.flowReview"),
    t("DashboardEarn.vaultWithdraw.flowProcessing"),
    t("DashboardEarn.vaultWithdraw.flowComplete"),
  ];
  const movementProcessing =
    visibleOutcome?.kind === "withdrawal" &&
    !visibleOutcome.absorbedByApproval &&
    (visibleOutcome.withdrawal.status === "requested" ||
      visibleOutcome.withdrawal.status === "submitted" ||
      visibleOutcome.withdrawal.status === "confirmed");
  const panelKey = withdrawalPanelKey(visibleOutcome, step);
  const contentRef = useModalFocus({
    focusKey: panelKey,
    initialFocusSelector: "[data-modal-focus-target]",
    fallbackAttribute: "data-earn-vault-withdraw-focus-fallback",
    fallbackValue: position.id,
    contentDataKey: "panel",
  });

  // Unmount "aborts" the SUBMISSION, not the request — same contract as the
  // deposit modal: the POST runs to completion so its answer reaches the key
  // store, and the signal only gates state updates.
  useEffect(
    () => () => {
      requestControllerRef.current?.abort();
    },
    []
  );

  const asset = earnMintAsset(position.tokenMint);
  const {
    amountError,
    amountValidation,
    availableAmount,
    continueBlocked,
    hasStakedShares,
    overAvailableAmount,
    quoteKey,
    quoteShares,
    sharesToRedeem,
    slippageBps,
    slippageInvalid,
  } = deriveWithdrawalFormState(
    position,
    amountInput,
    slippagePolicy,
    slippageInput,
    t("DashboardEarn.vaultWithdraw.amountInvalid")
  );
  const rawQuote = useDebouncedVaultQuote<EarnVaultWithdrawalPreview>(
    quoteKey,
    (signal) =>
      fetchEarnVaultWithdrawalPreview(
        { positionId: position.id, shares: quoteShares ?? "" },
        signal
      ),
    quoteRefreshKey
  );
  const quote = quoteForKey(rawQuote, quoteKey);
  const minAmountOut = derivedMinAmountOut(slippageBps, quote);
  const submitBlocked = continueBlocked || (slippagePolicy !== null && minAmountOut === undefined);

  async function submitResolvedIntent(controller: AbortController, shares: string, amount: string) {
    const fingerprint = vaultWithdrawalRequestFingerprint({
      projectId,
      positionId: position.id,
      shares,
      toleranceBps: slippagePolicy === null ? null : slippageBps,
    });
    const resolvedKey = await resolveHeldIdempotencyKey(
      vaultWithdrawalIdempotencyKeyStore,
      fingerprint,
      controller.signal,
      fetchEarnVaultWithdrawalsByRequestId
    );
    if (resolvedKey.kind === "aborted") return;
    if (resolvedKey.kind === "unavailable") {
      setSubmitError(t("DashboardEarn.vaultWithdraw.heldKeyUnavailable"));
      return;
    }

    // A HELD key must replay the floor it was MINTED with, verbatim — the
    // deposit modal documents why. A fresh key takes the freshly derived
    // floor, and records it for exactly that future replay.
    const heldFloor = resolvedKey.wasHeld ? recallVaultWithdrawalFloor(fingerprint) : undefined;
    const floorForRequest = heldFloor !== undefined ? heldFloor : (minAmountOut ?? null);
    rememberVaultWithdrawalFloor(fingerprint, floorForRequest);

    // No abort signal on the value-moving POST — see the deposit modal.
    const result = await createEarnVaultWithdrawal(
      {
        positionId: position.id,
        shares,
        ...(floorForRequest === null ? {} : { minAmountOut: floorForRequest }),
      },
      resolvedKey.key
    );
    // Key bookkeeping FIRST and unconditionally: the store outlives the
    // component, so an unmount mid-flight must not skip recording the answer.
    const disposition = applyIdempotencyKeyOutcome(
      vaultWithdrawalIdempotencyKeyStore,
      fingerprint,
      result
    );
    // A retired key can never be replayed, so its remembered floor is dead
    // weight the next fresh derivation must not inherit.
    if (disposition === "retired") forgetVaultWithdrawalFloor(fingerprint);
    if (controller.signal.aborted) return;
    const resolution = resolveWithdrawalSubmission(
      result,
      t("DashboardEarn.vaultWithdraw.submitError"),
      resolvedKey.wasHeld,
      // A blown floor gets THIS surface's own words and the control that
      // fixes it, not a relayed simulation log.
      t("DashboardEarn.vaultWithdraw.slippageExceeded")
    );
    if (resolution.kind === "error") {
      if (resolution.slippageExceeded) {
        // Open the control that fixes it, and re-quote: the retry's floor
        // must come from the rate that refused.
        setSlippageOpen(true);
        setQuoteRefreshKey((key) => key + 1);
      }
      setSubmitError(resolution.message);
      return;
    }
    setOutcome(resolution.outcome);
    if (resolution.withdrawn) {
      onWithdrawn?.(resolution.withdrawn, {
        amount,
        projectBalance: shouldProjectWithdrawalBalance(resolution.outcome),
      });
    }
  }

  async function submit() {
    if (
      submittingRef.current ||
      submitBlocked ||
      sharesToRedeem === undefined ||
      amountValidation.kind !== "valid"
    ) {
      return;
    }

    const controller = new AbortController();
    requestControllerRef.current?.abort();
    requestControllerRef.current = controller;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);

    try {
      await submitResolvedIntent(controller, sharesToRedeem, amountValidation.canonicalAmount);
    } catch (cause) {
      if (!controller.signal.aborted) {
        setSubmitError(
          cause instanceof Error && cause.message
            ? cause.message
            : t("DashboardEarn.vaultWithdraw.submitError")
        );
      }
    } finally {
      if (requestControllerRef.current === controller) requestControllerRef.current = null;
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  const modalLabel = t("DashboardEarn.vaultWithdraw.title", {
    position: position.label || shortenMarketAddress(position.providerReference),
  });

  if (visibleOutcome) {
    return (
      <Modal
        isOpen
        ariaLabel={modalLabel}
        contentClassName={movementProcessing ? "earn-processing-modal" : undefined}
        onClose={onClose}
        size="md"
      >
        <div className="p-6" ref={contentRef}>
          {movementProcessing ? <EarnProcessingFrame /> : null}
          <EarnFlowStepper currentStep={progressStep} steps={progressSteps} />
          <EarnFlowTransition stepKey={panelKey}>
            <WithdrawalResult
              environment={environment}
              onClose={onClose}
              outcome={visibleOutcome}
              position={position}
              requestedAmount={
                amountValidation.kind === "valid" ? amountValidation.canonicalAmount : amountInput
              }
            />
          </EarnFlowTransition>
        </div>
      </Modal>
    );
  }

  return (
    <Modal isOpen ariaLabel={modalLabel} closeDisabled={submitting} onClose={onClose} size="md">
      <div aria-busy={submitting} className="p-6" ref={contentRef}>
        <EarnFlowStepper currentStep={progressStep} steps={progressSteps} />
        <EarnFlowTransition stepKey={step}>
          <h2
            className="pr-8 text-lg font-medium leading-6 text-primary outline-none"
            data-modal-focus-target
            tabIndex={-1}
          >
            {modalLabel}
          </h2>

          {step === "details" ? (
            <WithdrawalDetailsStep
              amountError={amountError}
              amountInput={amountInput}
              availableAmount={availableAmount}
              continueBlocked={continueBlocked}
              hasStakedShares={hasStakedShares}
              onAmountChange={(value) => {
                setAmountInput(value);
                setSubmitError(null);
              }}
              onContinue={() => {
                setSubmitError(null);
                setStep("review");
              }}
              onMax={() => {
                if (availableAmount === undefined) return;
                setAmountInput(availableAmount);
                setSubmitError(null);
              }}
              overAvailableAmount={overAvailableAmount}
              positionValue={position.tokenValue}
              submitting={submitting}
            />
          ) : (
            <WithdrawalReviewStep
              amount={
                amountValidation.kind === "valid" ? amountValidation.canonicalAmount : amountInput
              }
              assetSymbol={asset.symbol}
              minAmountOut={minAmountOut}
              onBack={() => {
                setSubmitError(null);
                setStep("details");
              }}
              onSlippageChange={(value) => {
                setSlippageInput(value);
                setSubmitError(null);
              }}
              onSlippageToggle={() => setSlippageOpen((open) => !open)}
              onSubmit={() => void submit()}
              position={position}
              quote={quote}
              slippageBps={slippageBps}
              slippageInput={slippageInput}
              slippageInvalid={slippageInvalid}
              slippageOpen={slippageOpen}
              slippagePolicy={slippagePolicy}
              submitBlocked={submitBlocked}
              submitError={submitError}
              submitting={submitting}
            />
          )}
        </EarnFlowTransition>
      </div>
    </Modal>
  );
}
