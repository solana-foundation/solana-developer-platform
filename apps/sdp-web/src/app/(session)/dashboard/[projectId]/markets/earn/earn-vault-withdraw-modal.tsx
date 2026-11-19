"use client";

import type { SdpEnvironment } from "@sdp/types/api-keys";
import {
  type EarnVaultPosition,
  type EarnVaultWithdrawal,
  isLandedEarnVaultDirectMovementStatus,
} from "@sdp/types/earn";
import { earnWithdrawSlippageFloor } from "@sdp/types/provider-access";
import { CLUSTER_BY_SDP_ENVIRONMENT } from "@sdp/types/well-known-tokens";
import type { BadgeVariant } from "@sdp/ui/badge";
import { Button } from "@sdp/ui/button";
import { Callout } from "@sdp/ui/callout";
import { DetailList, DetailRow } from "@sdp/ui/detail-list";
import { Input } from "@sdp/ui/input";
import { Label } from "@sdp/ui/label";
import { Modal } from "@sdp/ui/modal";
import { StatusText } from "@sdp/ui/status-text";
import { type ChangeEvent, type FormEvent, useEffect, useRef, useState } from "react";
import { EarnFlowStepper } from "@/app/(session)/dashboard/[projectId]/markets/earn/earn-flow-stepper";
import { EarnFlowTransition } from "@/app/(session)/dashboard/[projectId]/markets/earn/earn-flow-transition";
import { EarnOutcomeMark } from "@/app/(session)/dashboard/[projectId]/markets/earn/earn-outcome-mark";
import { useLocale, useTranslations } from "@/i18n/provider";
import { fetchResultAnswer } from "@/lib/idempotency";
import { settleMoneyIdempotencyKey } from "@/lib/idempotency-key-store";
import { useModalFocus } from "@/lib/use-modal-focus";
import { EarnAmountMaxButton } from "./earn-amount-max-button";
import { compareUnsignedDecimals, isPositiveDecimal } from "./earn-decimal";
import { EarnErrorNote } from "./earn-error-note";
import { formatTokenValue, positionDisplayName } from "./earn-format";
import { earnMintAsset, TransactionLink } from "./earn-market-presentation";
import { EARN_TRANSACTION_MODAL_FRAME } from "./earn-modal";
import {
  createEarnVaultWithdrawal,
  type EarnVaultWithdrawalPreview,
  fetchEarnVaultWithdrawalPreview,
  useEarnVaultWithdrawalOutcome,
} from "./earn-program-data";
import type { VaultSubmissionObserver } from "./earn-vault-movement";

import {
  mergeObservedVaultMovement,
  observableVaultMovement,
  vaultMovementPanelKey,
  vaultMovementProcessing,
  vaultMovementProgressStep,
  vaultMovementProgressSteps,
} from "./earn-vault-movement";
import {
  derivedMinOut,
  floorToReplay,
  initialSlippageInput,
  isExpiredQuote,
  isSlippageExceededRefusal,
  parseSlippageToleranceState,
  quoteForKey,
  revalidateExpiredFloor,
  useDebouncedVaultQuote,
  type VaultFloorReplay,
  type VaultQuoteState,
} from "./earn-vault-slippage";
import { VaultQuoteNotices, VaultSlippageSection } from "./earn-vault-slippage-section";
import {
  earnStatusTextTone,
  earnVaultWithdrawalPositionStatusLabels,
  earnVaultWithdrawalUiState,
  vaultOutcomeTone,
} from "./earn-vault-ui-state";
import {
  VAULT_WITHDRAWAL_AMOUNT_DECIMALS,
  VAULT_WITHDRAWAL_SHARE_DECIMALS,
  validateVaultWithdrawalAmount,
  validateVaultWithdrawalShares,
  vaultProviderOrderShares,
  vaultWithdrawalAmountError,
  vaultWithdrawalAvailableAmount,
  vaultWithdrawalSharesForValidatedAmount,
} from "./earn-vault-withdraw-amount";
import {
  forgetVaultWithdrawalFloor,
  forgetVaultWithdrawalShares,
  recallLegacyVaultWithdrawalKeptKey,
  recallVaultWithdrawalFloor,
  recallVaultWithdrawalShares,
  rememberVaultWithdrawalFloor,
  rememberVaultWithdrawalShares,
  resolveVaultWithdrawalKeptKey,
  type VaultWithdrawalRecovery,
  vaultWithdrawalIdempotencyKeyStore,
  vaultWithdrawalRequestFingerprint,
} from "./earn-vault-withdraw-tracking";

function amountBalanceHint(
  t: ReturnType<typeof useTranslations>,
  locale: string,
  tokenMint: string,
  positionValue: string | undefined,
  availableAmount: string | undefined,
  hasStakedShares: boolean
): string {
  if (availableAmount === undefined) {
    return t("DashboardEarn.vaultWithdraw.amountUnavailable");
  }
  if (hasStakedShares && positionValue !== undefined) {
    return t("DashboardEarn.vaultWithdraw.amountAvailableOfTotal", {
      available: formatTokenValue(availableAmount, tokenMint, locale),
      total: formatTokenValue(positionValue, tokenMint, locale),
    });
  }
  return t("DashboardEarn.vaultWithdraw.amountAvailable", {
    amount: formatTokenValue(availableAmount, tokenMint, locale),
  });
}

function shareBalanceHint(
  t: ReturnType<typeof useTranslations>,
  shares: string | undefined,
  withdrawableShares: string | undefined,
  hasLockedShares: boolean
): string {
  if (withdrawableShares === undefined) {
    return t("DashboardEarn.vaultWithdraw.sharesUnknown");
  }
  if (hasLockedShares && shares !== undefined) {
    return t("DashboardEarn.vaultWithdraw.sharesAvailable", {
      available: withdrawableShares,
      total: shares,
    });
  }
  return t("DashboardEarn.vaultWithdraw.sharesHeld", { shares: withdrawableShares });
}

type WithdrawalOutcome = {
  kind: "withdrawal";
  movement: EarnVaultWithdrawal;
};

type WithdrawalSubmissionResolution =
  | { kind: "error"; message: string; slippageExceeded?: true }
  | { kind: "outcome"; outcome: WithdrawalOutcome; withdrawn?: EarnVaultWithdrawal };

/**
 * The share intent a submission sends, decided once from the key resolution:
 * an ADOPTED legacy key sends the shares parsed out of the legacy fingerprint
 * (the first attempt's intent, whatever the form now says); a provider
 * order's intent is its typed input itself; a FRESH atomic key sends the live
 * derivation; a KEPT atomic key replays the MINTED intent from the shares
 * memo — the API's fingerprint pins `shares`, so a fresh re-derivation from a
 * moved live position would be a changed request under a live key.
 * `undefined` for a reuse whose memo lost the intent: the caller stops,
 * submitting nothing, rather than pair the live key with a guess.
 */
function sharesForSubmission(
  settlement: EarnVaultWithdrawalSettlement,
  reused: boolean,
  quantity: string,
  derivedShares: string | undefined,
  fingerprint: string,
  adoptedShares?: string
): string | undefined {
  if (adoptedShares !== undefined) return adoptedShares;
  if (settlement === "provider_order") return quantity;
  return reused ? (recallVaultWithdrawalShares(fingerprint) ?? undefined) : derivedShares;
}

function resolveWithdrawalSubmission(
  result: Awaited<ReturnType<typeof createEarnVaultWithdrawal>>,
  fallbackError: string,
  slippageExceededMessage: string
): WithdrawalSubmissionResolution {
  if (!result.ok) {
    if (isSlippageExceededRefusal(result.body)) {
      return { kind: "error", message: slippageExceededMessage, slippageExceeded: true };
    }
    return { kind: "error", message: result.error || fallbackError };
  }
  const withdrawal = result.data.withdrawal;
  if (withdrawal.status === "failed") {
    return {
      kind: "error",
      message: withdrawal.failureReason || fallbackError,
    };
  }
  return {
    kind: "outcome",
    outcome: { kind: "withdrawal", movement: withdrawal },
    withdrawn: withdrawal,
  };
}

function withdrawalProgressStep(
  outcome: WithdrawalOutcome | null,
  step: "details" | "review",
  settlement: EarnVaultWithdrawalSettlement
): number {
  if (outcome?.movement.settlementOutcome !== undefined) return 4;
  if (settlement === "provider_order") {
    if (!outcome) return step === "review" ? 1 : 0;
    return isLandedEarnVaultDirectMovementStatus(outcome.movement.status) ? 3 : 2;
  }
  return vaultMovementProgressStep(outcome, step, earnVaultWithdrawalUiState);
}

function deriveWithdrawalFormState(
  position: EarnVaultPosition,
  amountInput: string,
  slippagePolicy: ReturnType<typeof earnWithdrawSlippageFloor>,
  slippageInput: string,
  invalidAmountMessage: string,
  settlement: EarnVaultWithdrawalSettlement
) {
  const amountValidation =
    settlement === "provider_order"
      ? validateVaultWithdrawalShares(amountInput)
      : validateVaultWithdrawalAmount(amountInput);
  const availableAmount =
    settlement === "provider_order"
      ? position.withdrawableShares
      : vaultWithdrawalAvailableAmount(position);
  const sharesToRedeem =
    settlement === "provider_order"
      ? amountValidation.kind === "valid"
        ? vaultProviderOrderShares(amountValidation.canonicalAmount, position)
        : undefined
      : vaultWithdrawalSharesForValidatedAmount(amountValidation, position);
  const hasStakedShares =
    position.shares !== undefined &&
    position.withdrawableShares !== undefined &&
    compareUnsignedDecimals(position.shares, position.withdrawableShares) === 1;
  const overAvailableAmount =
    amountValidation.kind === "valid" && availableAmount !== undefined
      ? compareUnsignedDecimals(amountValidation.canonicalAmount, availableAmount) === 1
      : false;
  const amountError = vaultWithdrawalAmountError(
    amountInput,
    amountValidation,
    invalidAmountMessage
  );
  const { slippageBps, slippageInvalid } = parseSlippageToleranceState(
    slippagePolicy,
    slippageInput
  );
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

interface WithdrawalResultCopy {
  body: string;
  note: string;
  status: string;
  statusVariant: BadgeVariant;
  title: string;
}

export type EarnVaultWithdrawalSettlement = "atomic" | "provider_order";

function withdrawalResultCopy(
  outcome: WithdrawalOutcome,
  t: ReturnType<typeof useTranslations>,
  settlement: EarnVaultWithdrawalSettlement
): WithdrawalResultCopy {
  if (outcome.movement.settlementOutcome === "cancelled")
    return {
      title: t("DashboardEarn.providerAction.cancelled"),
      body: t("DashboardEarn.providerAction.cancelledBody"),
      note: "",
      status: t("DashboardEarn.providerAction.cancelledStatus"),
      statusVariant: "info",
    };
  if (outcome.movement.settlementOutcome === "delivered")
    return {
      title: t("DashboardEarn.providerAction.delivered"),
      body: t("DashboardEarn.providerAction.deliveredBody"),
      note: "",
      status: t("DashboardEarn.providerAction.delivered"),
      statusVariant: "success",
    };
  if (settlement === "provider_order") {
    if (outcome.movement.status === "failed") {
      return {
        title: t("DashboardEarn.vaultWithdraw.providerOrderFailedTitle"),
        body: t("DashboardEarn.vaultWithdraw.providerOrderFailedBody"),
        note: t("DashboardEarn.vaultWithdraw.providerOrderNote"),
        status: t("DashboardEarn.vaultWithdraw.providerOrderFailedStatus"),
        statusVariant: "danger",
      };
    }
    const chainObserved = isLandedEarnVaultDirectMovementStatus(outcome.movement.status);
    return {
      title: t("DashboardEarn.vaultWithdraw.providerOrderTitle"),
      body: t(
        outcome.movement.status === "finalized"
          ? "DashboardEarn.vaultWithdraw.providerOrderLandedBody"
          : chainObserved
            ? "DashboardEarn.vaultWithdraw.providerOrderConfirmedBody"
            : "DashboardEarn.vaultWithdraw.providerOrderPendingBody"
      ),
      note: t("DashboardEarn.vaultWithdraw.providerOrderNote"),
      status: t(
        chainObserved
          ? "DashboardEarn.vaultWithdraw.providerOrderAwaitingStatus"
          : "DashboardEarn.vaultWithdraw.providerOrderPendingStatus"
      ),
      statusVariant: "warning",
    };
  }
  switch (outcome.movement.status) {
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
        note: t("DashboardEarn.vaultWithdraw.balanceRefreshNote"),
        status: t("DashboardEarn.vaultWithdraw.confirmedStatus"),
        statusVariant: "success",
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
        note: t("DashboardEarn.vaultWithdraw.balanceRefreshNote"),
        status: t("DashboardEarn.vaultWithdraw.submittedStatus"),
        statusVariant: "default",
      };
  }
}

function WithdrawalResult({
  outcome,
  environment,
  onClose,
  position,
  requestedAmount,
  settlement,
}: {
  outcome: WithdrawalOutcome;
  environment: SdpEnvironment;
  onClose: () => void;
  position: EarnVaultPosition;
  requestedAmount: string;
  settlement: EarnVaultWithdrawalSettlement;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const asset = earnMintAsset(position.tokenMint);
  const positionName = positionDisplayName(position);

  const { movement: withdrawal } = outcome;
  const copy = withdrawalResultCopy(outcome, t, settlement);
  const sharedStatus =
    settlement === "provider_order"
      ? null
      : earnVaultWithdrawalPositionStatusLabels(withdrawal, position.shares, t);
  const status = sharedStatus?.label ?? copy.status;
  const statusVariant: BadgeVariant = sharedStatus?.variant ?? copy.statusVariant;
  const processing = withdrawal.status === "requested" || withdrawal.status === "submitted";

  return (
    <>
      {processing ? null : <EarnOutcomeMark tone={vaultOutcomeTone(statusVariant)} />}
      <div className="flex items-center gap-3 pr-8">
        <h2
          className="text-subheading font-medium text-primary outline-none"
          data-modal-focus-target
          tabIndex={-1}
        >
          {copy.title}
        </h2>
        <StatusText className="shrink-0 text-body" tone={earnStatusTextTone(statusVariant)}>
          {status}
        </StatusText>
      </div>
      <p className="mt-2 text-body text-secondary">{copy.body}</p>

      <DetailList className="mt-5" variant="summary">
        <DetailRow fit="wrap" label={t("DashboardEarn.deposit.vaultStrategy")}>
          {positionName}
        </DetailRow>
        <DetailRow
          label={t(
            settlement === "provider_order"
              ? "DashboardEarn.vaultWithdraw.sharesLabel"
              : "DashboardEarn.vaultWithdraw.amountLabel"
          )}
          fit="figure"
        >
          <span className="tabular-nums">
            {settlement === "provider_order"
              ? requestedAmount
              : formatTokenValue(requestedAmount, asset.mint, locale)}
          </span>
        </DetailRow>
        {settlement === "provider_order" ? null : (
          <DetailRow label={t("DashboardEarn.vaultWithdraw.receiveAs")}>{asset.symbol}</DetailRow>
        )}
        {withdrawal.status === "requested" ? null : (
          <DetailRow label={t("DashboardEarn.vaultWithdraw.transaction")}>
            <TransactionLink
              cluster={CLUSTER_BY_SDP_ENVIRONMENT[environment]}
              signature={withdrawal.signature}
            />
          </DetailRow>
        )}
      </DetailList>
      <p className="mt-4 text-meta text-tertiary">{copy.note}</p>
      <div className="mt-5 flex justify-end">
        <Button onClick={onClose}>{t("DashboardEarn.withdraw.done")}</Button>
      </div>
    </>
  );
}

export interface EarnVaultWithdrawModalProps {
  redemptionMode?: "standard" | "instant";
  onSubmissionStart?: VaultSubmissionObserver;
  position: EarnVaultPosition;
  environment: SdpEnvironment;
  /** Part of the request fingerprint — see `vaultWithdrawalRequestFingerprint`. */
  projectId: string | null;
  onClose: () => void;
  onWithdrawn?: (
    withdrawal: EarnVaultWithdrawal,
    intent: {
      amount: string;
      /** Client clock when the POST began; a positions read that landed earlier cannot contain this exit. */
      submittedAt: number;
    }
  ) => void;
  onMovementUpdated?: (withdrawal: EarnVaultWithdrawal) => void;
  /** How the direct redemption transaction delivers proceeds. */
  settlement?: EarnVaultWithdrawalSettlement;
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
  settlement: EarnVaultWithdrawalSettlement;
  shares: string | undefined;
  submitting: boolean;
  tokenMint: string;
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
    settlement,
    shares,
    submitting,
    tokenMint,
  } = props;
  const locale = useLocale();
  const t = useTranslations();
  // A form, so Enter in the amount continues to the review as the button does.
  const continueFromForm = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!continueBlocked) onContinue();
  };

  return (
    <form noValidate onSubmit={continueFromForm}>
      <div className="mt-5 flex flex-col gap-2">
        <Label htmlFor="earn-vault-withdraw-amount">
          {t(
            settlement === "provider_order"
              ? "DashboardEarn.vaultWithdraw.sharesLabel"
              : "DashboardEarn.vaultWithdraw.amountLabel"
          )}
        </Label>
        <Input
          action={
            <EarnAmountMaxButton
              disabled={
                submitting || availableAmount === undefined || !isPositiveDecimal(availableAmount)
              }
              label={t("DashboardEarn.vaultWithdraw.max")}
              onClick={onMax}
            />
          }
          aria-describedby="earn-vault-withdraw-balance"
          aria-invalid={amountError ? true : undefined}
          disabled={submitting}
          id="earn-vault-withdraw-amount"
          inputMode="decimal"
          leadingAddon={
            settlement === "provider_order" ? undefined : <span aria-hidden="true">$</span>
          }
          maxDecimals={
            settlement === "provider_order"
              ? VAULT_WITHDRAWAL_SHARE_DECIMALS
              : VAULT_WITHDRAWAL_AMOUNT_DECIMALS
          }
          onChange={(event: ChangeEvent<HTMLInputElement>) => onAmountChange(event.target.value)}
          placeholder="0.00"
          value={amountInput}
        />
        <div className="min-h-5 text-meta text-tertiary" id="earn-vault-withdraw-balance">
          {settlement === "provider_order"
            ? shareBalanceHint(t, shares, availableAmount, hasStakedShares)
            : amountBalanceHint(
                t,
                locale,
                tokenMint,
                positionValue,
                availableAmount,
                hasStakedShares
              )}
        </div>
        {amountError ? (
          <p className="text-meta text-error" role="alert">
            {amountError}
          </p>
        ) : null}
        {overAvailableAmount ? (
          <p className="text-meta text-warning" role="status">
            {t(
              settlement === "provider_order"
                ? "DashboardEarn.vaultWithdraw.overShares"
                : "DashboardEarn.vaultWithdraw.overAmount"
            )}
          </p>
        ) : null}
      </div>

      <div className="mt-6">
        <Button className="!w-full" disabled={continueBlocked} type="submit">
          {t("DashboardEarn.deposit.continueAction")}
        </Button>
      </div>
    </form>
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
  recovery: VaultWithdrawalRecovery | undefined;
  slippageBps: number | null;
  slippageInput: string;
  slippageInvalid: boolean;
  slippageOpen: boolean;
  slippagePolicy: ReturnType<typeof earnWithdrawSlippageFloor>;
  settlement: EarnVaultWithdrawalSettlement;
  submitBlocked: boolean;
  submitError: string | null;
  submitting: boolean;
}

function ProviderOrderReviewRows({ amount }: { amount: string }) {
  const t = useTranslations();

  return (
    <DetailRow fit="figure" label={t("DashboardEarn.vaultWithdraw.sharesLabel")}>
      <span className="tabular-nums">{amount}</span>
    </DetailRow>
  );
}

function AtomicReviewRows({
  amount,
  assetSymbol,
  minAmountOut,
  quote,
  tokenMint,
}: {
  amount: string;
  assetSymbol: string;
  minAmountOut: string | undefined;
  quote: VaultQuoteState<EarnVaultWithdrawalPreview>;
  tokenMint: string;
}) {
  const locale = useLocale();
  const t = useTranslations();

  return (
    <>
      <DetailRow fit="figure" label={t("DashboardEarn.vaultWithdraw.amountLabel")}>
        <span className="tabular-nums">{formatTokenValue(amount, tokenMint, locale)}</span>
      </DetailRow>
      <DetailRow label={t("DashboardEarn.vaultWithdraw.receiveAs")}>{assetSymbol}</DetailRow>
      {quote.kind === "quoted" && quote.preview.blockingIssues.length === 0 ? (
        <DetailRow fit="figure" label={t("DashboardEarn.vaultWithdraw.expectedAmount")}>
          <span className="tabular-nums">
            {formatTokenValue(quote.preview.assetsOut, tokenMint, locale)}
          </span>
        </DetailRow>
      ) : null}
      {minAmountOut !== undefined ? (
        <DetailRow fit="figure" label={t("DashboardEarn.vaultWithdraw.minAmount")}>
          <span className="tabular-nums">{formatTokenValue(minAmountOut, tokenMint, locale)}</span>
        </DetailRow>
      ) : null}
    </>
  );
}

function ReviewAmountRows({
  amount,
  assetSymbol,
  minAmountOut,
  quote,
  settlement,
  tokenMint,
}: {
  amount: string;
  assetSymbol: string;
  minAmountOut: string | undefined;
  quote: VaultQuoteState<EarnVaultWithdrawalPreview>;
  settlement: EarnVaultWithdrawalSettlement;
  tokenMint: string;
}) {
  if (settlement === "provider_order") {
    return <ProviderOrderReviewRows amount={amount} />;
  }
  return (
    <AtomicReviewRows
      amount={amount}
      assetSymbol={assetSymbol}
      minAmountOut={minAmountOut}
      quote={quote}
      tokenMint={tokenMint}
    />
  );
}

/**
 * The review-step notice for an ADOPTED previous-build attempt (see
 * `recallLegacyVaultWithdrawalKeptKey`): what a confirm here submits is the
 * RECOVERED shares and floor, which are generally not the amount the form is
 * showing, so the review must say so before the submit, not after. When the
 * recovered floor was LOST (`undefined`) the attempt cannot be replayed
 * exactly and nothing will be sent — the notice says that instead of a
 * confirm that could only fail or double-exit.
 */
function VaultWithdrawalRecoveryNotice({
  locale,
  position,
  recovery,
}: {
  locale: string;
  position: EarnVaultPosition;
  recovery: VaultWithdrawalRecovery;
}) {
  const t = useTranslations();
  const shares = formatTokenValue(recovery.shares, position.shareMint, locale);
  if (recovery.floor === undefined) {
    return (
      <Callout className="mt-4" variant="warning">
        {t("DashboardEarn.vaultWithdraw.legacyAttemptUnrecoverable", { shares })}
      </Callout>
    );
  }
  if (recovery.floor === null) {
    return (
      <Callout className="mt-4" variant="warning">
        {t("DashboardEarn.vaultWithdraw.legacyAttemptReviewNote", { shares })}
      </Callout>
    );
  }
  const floor = formatTokenValue(recovery.floor, position.tokenMint, locale);
  return (
    <Callout className="mt-4" variant="warning">
      {t("DashboardEarn.vaultWithdraw.legacyAttemptReviewNoteWithFloor", { shares, floor })}
    </Callout>
  );
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
    recovery,
    slippageBps,
    slippageInput,
    slippageInvalid,
    slippageOpen,
    slippagePolicy,
    settlement,
    submitBlocked,
    submitError,
    submitting,
  } = props;
  const locale = useLocale();
  const t = useTranslations();

  return (
    <>
      <DetailList className="mt-5" variant="summary">
        <DetailRow fit="wrap" label={t("DashboardEarn.deposit.vaultStrategy")}>
          {positionDisplayName(position)}
        </DetailRow>
        <ReviewAmountRows
          amount={amount}
          assetSymbol={assetSymbol}
          minAmountOut={minAmountOut}
          quote={quote}
          settlement={settlement}
          tokenMint={position.tokenMint}
        />
      </DetailList>

      {recovery ? (
        <VaultWithdrawalRecoveryNotice locale={locale} position={position} recovery={recovery} />
      ) : null}

      {settlement === "provider_order" ? null : (
        <VaultQuoteNotices
          decimals={(preview) => preview.assetDecimals}
          keys={{
            blocked: "DashboardEarn.vaultWithdraw.quoteBlocked",
            loading: "DashboardEarn.vaultWithdraw.quoteLoading",
            unavailable: "DashboardEarn.vaultWithdraw.quoteUnavailable",
            zero: "DashboardEarn.vaultWithdraw.quoteZeroAssets",
          }}
          quantity={(preview) => preview.assetsOut}
          quote={quote}
        />
      )}

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

      {settlement === "provider_order" ? (
        <p className="mt-4 text-meta text-tertiary">
          {t("DashboardEarn.vaultWithdraw.providerOrderReviewNote")}
        </p>
      ) : null}
      <p className="mt-4 text-meta text-tertiary">
        {position.feeSponsored
          ? t("DashboardEarn.vaultWithdraw.confirmNoteSponsored")
          : t("DashboardEarn.vaultWithdraw.confirmNote")}
      </p>
      {submitError ? <EarnErrorNote message={submitError} /> : null}

      <div className="mt-6 flex gap-2">
        <Button className="flex-1" disabled={submitting} onClick={onBack} variant="outline">
          {t("DashboardEarn.deposit.back")}
        </Button>
        <Button
          className="flex-[2]"
          disabled={submitBlocked}
          loading={submitting}
          onClick={onSubmit}
        >
          {t("DashboardEarn.vaultWithdraw.submit")}
        </Button>
      </div>
    </>
  );
}

/**
 * Exit a vault position. Atomic exits start from a stablecoin amount and use
 * the live position value to derive shares. Provider-settled redemptions start
 * from exact shares because their cash amount does not exist until NAV strike.
 */
export function EarnVaultWithdrawModal({
  position,
  environment,
  projectId,
  onClose,
  onWithdrawn,
  onSubmissionStart,
  onMovementUpdated,
  settlement = "atomic",
  redemptionMode,
}: EarnVaultWithdrawModalProps) {
  const t = useTranslations();
  const [amountInput, setAmountInput] = useState("");
  // Declared per provider in @sdp/types: non-null means this provider REQUIRES
  // an explicit exit floor derived from a live quote. Null renders no slippage
  // control and sends no floor — Kamino's contract is unchanged. A provider
  // order has no cash quote to floor before NAV is struck, even if a future
  // provider configuration accidentally declares an atomic exit floor.
  const slippagePolicy =
    settlement === "provider_order" ? null : earnWithdrawSlippageFloor(position.provider);
  const [slippageInput, setSlippageInput] = useState(() => initialSlippageInput(slippagePolicy));
  const [slippageOpen, setSlippageOpen] = useState(false);
  const [step, setStep] = useState<"details" | "review">("details");
  const [quoteRefreshKey, setQuoteRefreshKey] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<WithdrawalOutcome | null>(null);
  // Mount-time SNAPSHOT of the previous build's unresolved attempt on this
  // exit (see `recallLegacyVaultWithdrawalKeptKey`): the scan runs once, so
  // what the review surfaces and what the submit adopts is the same attempt —
  // never a silent mid-session re-scan that could submit shares the customer
  // never saw. The review notice presents it; the submit's resolver consumes
  // the snapshot only. `undefined` server-side and when nothing legacy is
  // kept.
  const [recovery, setRecovery] = useState(() =>
    recallLegacyVaultWithdrawalKeptKey({ projectId, positionId: position.id, redemptionMode })
  );
  const submittingRef = useRef(false);
  const requestControllerRef = useRef<AbortController | null>(null);
  const observedWithdrawal = useEarnVaultWithdrawalOutcome(
    observableVaultMovement(outcome)?.movementId,
    undefined,
    onMovementUpdated
  );
  const visibleOutcome = mergeObservedVaultMovement(outcome, observedWithdrawal);
  const progressStep = withdrawalProgressStep(visibleOutcome, step, settlement);
  const progressSteps = vaultMovementProgressSteps(
    {
      complete: t("DashboardEarn.vaultWithdraw.flowComplete"),
      details: t("DashboardEarn.vaultWithdraw.flowDetails"),
      processing: t("DashboardEarn.vaultWithdraw.flowProcessing"),
      providerSettlement: t("DashboardEarn.vaultWithdraw.flowProviderSettlement"),
      review: t("DashboardEarn.vaultWithdraw.flowReview"),
    },
    settlement === "provider_order"
  );
  const movementProcessing = vaultMovementProcessing(visibleOutcome, ["requested", "submitted"]);
  const panelKey = vaultMovementPanelKey(visibleOutcome, step, "withdrawal");
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
    t(
      settlement === "provider_order"
        ? "DashboardEarn.vaultWithdraw.sharesInvalid"
        : "DashboardEarn.vaultWithdraw.amountInvalid"
    ),
    settlement
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
  const minAmountOut = derivedMinOut(
    slippageBps,
    quote,
    (preview) => preview.assetsOut,
    (preview) => preview.assetDecimals
  );
  const submitBlocked = continueBlocked || (slippagePolicy !== null && minAmountOut === undefined);

  /**
   * EXPIRY BACKSTOP (PRO-1691), the state half. The quote hook re-quotes on
   * its own, but timers throttle in background tabs, so the floor on screen
   * can be older than the TTL at submit. A replayed floor — a kept key's
   * minted floor, which must go out verbatim — or a fresh one passes straight
   * through. An expired one is revalidated first; a rate that moved beyond it
   * stops the submission on THIS side of the API, through the same copy and
   * control as a blown floor, and either way the displayed quote re-syncs.
   * Returns whether to proceed.
   */
  async function floorSafeToSubmit(
    controller: AbortController,
    shares: string,
    replay: VaultFloorReplay,
    floor: string | null
  ): Promise<boolean> {
    if (replay.kind !== "fresh" || floor === null || !isExpiredQuote(quote)) return true;
    const verdict = await revalidateExpiredFloor(
      (signal) => fetchEarnVaultWithdrawalPreview({ positionId: position.id, shares }, signal),
      (preview) => preview.assetsOut,
      floor,
      controller.signal
    );
    if (verdict === "still_satisfiable") return true;
    if (verdict === "aborted") return false;
    if (verdict === "floor_exceeded") setSlippageOpen(true);
    setQuoteRefreshKey((refresh) => refresh + 1);
    setSubmitError(
      verdict === "floor_exceeded"
        ? t("DashboardEarn.vaultWithdraw.slippageExceeded")
        : t("DashboardEarn.vaultWithdraw.quoteUnavailable")
    );
    return false;
  }

  // Re-scan for the next-oldest kept legacy attempt, if any. Only ever runs
  // after a resolution the customer watched — never silently ahead of an
  // unreviewed submit (see the mount-time snapshot above).
  function rescanLegacyRecovery(): void {
    setRecovery(
      recallLegacyVaultWithdrawalKeptKey({ projectId, positionId: position.id, redemptionMode })
    );
  }

  // An adopted legacy attempt's own answer retires ITS key — which spent this
  // recovery — so re-scan once that answer resolves. A key kept under an
  // UNKNOWN answer leaves the snapshot alone, so a retry re-adopts the same
  // attempt.
  function rescanAdoptedRecovery(adoptedShares: string | undefined): void {
    if (adoptedShares !== undefined) rescanLegacyRecovery();
  }

  // A confirm whose recovered key was answered between the mount-time
  // snapshot and the confirm — an adopted replay sent from a previous visit,
  // retired by its late answer — stops here: that confirm was approved as a
  // REPLAY of the earlier attempt, never a fresh exit over it, and minting
  // under the typed quantity would be exactly the second exit the adoption
  // exists to prevent. The spent snapshot is re-scanned away (nothing legacy
  // is kept any more), so the next confirm — re-reviewed, notice gone — is a
  // normal typed-quantity submission.
  function stopOnSpentRecovery(recoverySpent: boolean | undefined): boolean {
    if (!recoverySpent) return false;
    rescanLegacyRecovery();
    setSubmitError(t("DashboardEarn.vaultWithdraw.floorUnavailable"));
    return true;
  }

  async function submitResolvedIntent(controller: AbortController, quantity: string) {
    // Keyed by the user's TYPED quantity, never the derived share intent:
    // the atomic exit derives its shares from the live position value, which
    // the positions polls keep moving — a fingerprint on them drifts under a
    // kept key, the retry misses it and mints a SECOND key whose submit can
    // exit again while the first attempt may already have executed. The
    // tracking module documents the fingerprint's other terms — including the
    // UPGRADE RECOVERY: the previous build keyed its kept entries on the
    // derived shares, so a retry of such an attempt resolves to nothing this
    // build computed. The adoption surfaced for review (the mount-time
    // recovery state) decides instead — the submission then runs under the
    // LEGACY fingerprint and replays THAT attempt exactly, its own key,
    // shares, and minted floor, so the API answers the first attempt either
    // way and the answer retires the legacy key.
    const { fingerprint, reused, adoptedShares, recoverySpent } = resolveVaultWithdrawalKeptKey({
      fingerprint: vaultWithdrawalRequestFingerprint({
        projectId,
        positionId: position.id,
        quantity,
        toleranceBps: slippagePolicy === null ? null : slippageBps,
        redemptionMode,
      }),
      recovery,
    });
    if (stopOnSpentRecovery(recoverySpent)) return;

    // A KEPT key — one an earlier attempt left unretired (a lost answer, a 5xx,
    // a refusal that settled nothing) — must replay the request it was MINTED
    // with, verbatim: the API's own idempotency fingerprint includes both
    // `shares` and the floor, and a changed body under the key is a 422, which
    // retires the key and lets the next submit mint a fresh one while the
    // first attempt may already have exited. Two memos answer for it. The
    // floor memo is the deposit modal's, documented there. The SHARES memo
    // exists because a fresh atomic derivation would silently re-derive the
    // share intent from a MOVED live position — the fingerprint now keys on
    // the typed quantity, so the kept key is found and the minted shares must
    // be remembered (`rememberVaultWithdrawalShares`) and replayed. A provider
    // order's shares are its typed input itself. An ADOPTED legacy key's
    // shares came out of the legacy fingerprint itself. A reuse whose memos
    // LOST either value cannot resubmit safely at all — it stops here,
    // submitting nothing, rather than pair the live key with a changed request.
    const shares = sharesForSubmission(
      settlement,
      reused,
      quantity,
      sharesToRedeem,
      fingerprint,
      adoptedShares
    );
    if (shares === undefined) {
      // Reachable only on a reuse whose shares memo was lost — submit() gates
      // the fresh path. The same posture as a lost floor below.
      setSubmitError(t("DashboardEarn.vaultWithdraw.floorUnavailable"));
      return;
    }
    const replay = floorToReplay(
      { reused },
      recallVaultWithdrawalFloor,
      fingerprint,
      minAmountOut ?? null
    );
    if (replay.kind === "unavailable") {
      setSubmitError(t("DashboardEarn.vaultWithdraw.floorUnavailable"));
      return;
    }
    if (!(await floorSafeToSubmit(controller, shares, replay, replay.floor))) return;
    rememberVaultWithdrawalFloor(fingerprint, replay.floor);
    rememberVaultWithdrawalShares(fingerprint, shares);

    // No abort signal on the value-moving POST — see the deposit modal.
    const submittedAt = Date.now();
    const { key, persisted } = vaultWithdrawalIdempotencyKeyStore.claim(fingerprint);
    if (!persisted) {
      setSubmitError(t("DashboardEarn.intentStorageUnavailable"));
      return;
    }
    const result = await createEarnVaultWithdrawal(
      {
        positionId: position.id,
        shares,
        redemptionMode,
        ...(replay.floor === null ? {} : { minAmountOut: replay.floor }),
      },
      key
    );
    // Key bookkeeping FIRST and unconditionally: the store outlives the
    // component, so an unmount mid-flight must not skip recording the answer.
    // A money movement: an unknown outcome or a reused key keeps the key
    // (`moneyAnswerRetiresKey`).
    const retired = settleMoneyIdempotencyKey(
      vaultWithdrawalIdempotencyKeyStore,
      fingerprint,
      key,
      fetchResultAnswer(result)
    );
    // A slippage refusal comes from simulation, run only after no movement was
    // found under this key: the retry is a new request (see the deposit modal).
    const slippageRefused = !result.ok && isSlippageExceededRefusal(result.body);
    if (slippageRefused) vaultWithdrawalIdempotencyKeyStore.release(fingerprint, key);
    // A retired key can never be replayed, so its remembered floor and shares
    // are dead weight the next fresh derivation must not inherit.
    if (retired || slippageRefused) {
      forgetVaultWithdrawalFloor(fingerprint);
      forgetVaultWithdrawalShares(fingerprint);
      rescanAdoptedRecovery(adoptedShares);
    }
    if (controller.signal.aborted) return;
    const resolution = resolveWithdrawalSubmission(
      result,
      t("DashboardEarn.vaultWithdraw.submitError"),
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
        amount: quantity,
        submittedAt,
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
    const finishSubmission = onSubmissionStart?.(position.custodyWalletId);
    setSubmitError(null);

    try {
      await submitResolvedIntent(controller, amountValidation.canonicalAmount);
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
      finishSubmission?.();
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  const modalLabel = t("DashboardEarn.vaultWithdraw.title", {
    position: positionDisplayName(position),
  });

  if (visibleOutcome) {
    return (
      <Modal
        isOpen
        ariaLabel={modalLabel}
        contentClassName={movementProcessing ? "earn-processing-modal" : undefined}
        onClose={onClose}
        {...EARN_TRANSACTION_MODAL_FRAME}
      >
        <div className="p-6" ref={contentRef}>
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
              settlement={settlement}
            />
          </EarnFlowTransition>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      isOpen
      ariaLabel={modalLabel}
      closeDisabled={submitting}
      onClose={onClose}
      {...EARN_TRANSACTION_MODAL_FRAME}
    >
      <div aria-busy={submitting} className="p-6" ref={contentRef}>
        <EarnFlowStepper currentStep={progressStep} steps={progressSteps} />
        <EarnFlowTransition stepKey={step}>
          <h2
            className="pr-8 text-subheading font-medium text-primary outline-none"
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
              settlement={settlement}
              shares={position.shares}
              submitting={submitting}
              tokenMint={position.tokenMint}
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
              recovery={recovery}
              slippageBps={slippageBps}
              slippageInput={slippageInput}
              slippageInvalid={slippageInvalid}
              slippageOpen={slippageOpen}
              slippagePolicy={slippagePolicy}
              settlement={settlement}
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
