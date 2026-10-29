"use client";

import type { SdpEnvironment } from "@sdp/types/api-keys";
import type {
  EarnVaultParRedemptionPreview,
  EarnVaultParRedemptionTerms,
  EarnVaultParRedemptionTermsRequest,
  EarnVaultPosition,
  EarnVaultWithdrawalRequestRecord,
} from "@sdp/types/earn";
import { CLUSTER_BY_SDP_ENVIRONMENT } from "@sdp/types/well-known-tokens";
import { Button } from "@sdp/ui/button";
import { Callout } from "@sdp/ui/callout";
import { DetailList, DetailRow } from "@sdp/ui/detail-list";
import { Input } from "@sdp/ui/input";
import { Label } from "@sdp/ui/label";
import { Modal } from "@sdp/ui/modal";
import { StatusText } from "@sdp/ui/status-text";
import { Loader2Icon } from "lucide-react";
import { type ChangeEvent, type FormEvent, useMemo, useState } from "react";
import { EarnFlowStepper } from "@/app/dashboard/[projectId]/markets/earn/earn-flow-stepper";
import { EarnFlowTransition } from "@/app/dashboard/[projectId]/markets/earn/earn-flow-transition";
import { EarnOutcomeMark } from "@/app/dashboard/[projectId]/markets/earn/earn-outcome-mark";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import { EarnAmountMaxButton } from "./earn-amount-max-button";
import { compareUnsignedDecimals, isPositiveDecimal } from "./earn-decimal";
import { EarnErrorNote } from "./earn-error-note";
import { formatProviderAmount, formatTokenValue, positionDisplayName } from "./earn-format";
import { TransactionLink } from "./earn-market-presentation";
import { EARN_TRANSACTION_MODAL_FRAME } from "./earn-modal";
import {
  fetchEarnVaultParRedemptionPreview,
  useEarnVaultWithdrawalRequestOutcome,
} from "./earn-program-data";
import type { EarnVaultAsyncWithdrawalIntent } from "./earn-vault-async-withdrawal-tracking";
import type { VaultSubmissionObserver } from "./earn-vault-movement";
import {
  earnVaultParRedemptionStatusPresentation,
  isEarnVaultParRedemptionCancelable,
  isEarnVaultParRedemptionTerminal,
} from "./earn-vault-par-redemption-presentation";
import { earnStatusTextTone } from "./earn-vault-ui-state";
import {
  VAULT_WITHDRAWAL_AMOUNT_DECIMALS,
  validateVaultWithdrawalAmount,
  vaultWithdrawalAvailableAmount,
  vaultWithdrawalSharesForAmount,
} from "./earn-vault-withdraw-amount";
import {
  useEarnVaultWithdrawalPreview,
  useEarnVaultWithdrawalRequestView,
  useEarnVaultWithdrawalSubmission,
  type WithdrawalFlowStep,
  withdrawalFlowStepIndex,
  withdrawalFlowStepKey,
  withdrawalFlowSteps,
} from "./earn-vault-withdrawal-flow";

/** What the request redeems: position shares, or the position's held `parIntermediate`. */
export type EarnVaultParRedemptionSource = "shares" | "intermediate";

interface EarnVaultParRedemptionModalProps {
  environment: SdpEnvironment;
  onClose: () => void;
  onRequested?: (request: EarnVaultWithdrawalRequestRecord) => void;
  onSubmissionStart?: VaultSubmissionObserver;
  onSettled?: (request: EarnVaultWithdrawalRequestRecord) => void;
  position: EarnVaultPosition;
  projectId: string | null;
  source?: EarnVaultParRedemptionSource;
  terms: EarnVaultParRedemptionTerms;
}

type FormStep = WithdrawalFlowStep;

/** Copy that names what the request redeems, chosen once per source. */
const PAR_SOURCE_COPY: Record<
  EarnVaultParRedemptionSource,
  Record<
    "detailsBody" | "operatorNotice" | "reviewBody" | "reviewNotice" | "title" | "unit",
    MessageKey
  >
> = {
  shares: {
    detailsBody: "DashboardEarn.parRedemption.detailsBody",
    operatorNotice: "DashboardEarn.parRedemption.operatorNotice",
    reviewBody: "DashboardEarn.parRedemption.reviewBody",
    reviewNotice: "DashboardEarn.parRedemption.reviewNotice",
    title: "DashboardEarn.parRedemption.title",
    unit: "DashboardEarn.parRedemption.shareUnit",
  },
  intermediate: {
    detailsBody: "DashboardEarn.parRedemption.detailsBodyIntermediate",
    operatorNotice: "DashboardEarn.parRedemption.operatorNoticeIntermediate",
    reviewBody: "DashboardEarn.parRedemption.reviewBodyIntermediate",
    reviewNotice: "DashboardEarn.parRedemption.reviewNoticeIntermediate",
    title: "DashboardEarn.parRedemption.titleIntermediate",
    unit: "DashboardEarn.parRedemption.intermediateUnit",
  },
};

function parMinimum(
  terms: EarnVaultParRedemptionTerms,
  source: EarnVaultParRedemptionSource
): string | undefined {
  return source === "intermediate"
    ? terms.minimumIntermediateAmount
    : (terms.minimumShares ?? undefined);
}

// Hastra documents this off-chain operator/CCTP batching threshold. It is an
// advisory, not a program rule: v0.0.6 accepts a one-atom request, so the UI
// must disclose the operational risk without misrepresenting it as on-chain.
const HASTRA_OPERATOR_BATCH_MINIMUM_USDC = "2000";

function parPreviewInput(
  position: EarnVaultPosition,
  amountState: Pick<
    ReturnType<typeof parRedemptionAmountState>,
    "belowMinimum" | "intermediateAmount" | "overAvailableAmount" | "shares"
  >
): EarnVaultParRedemptionTermsRequest | null {
  if (amountState.belowMinimum) return null;
  if (amountState.intermediateAmount !== undefined) {
    if (amountState.overAvailableAmount) return null;
    return {
      positionId: position.id,
      intermediateAmount: amountState.intermediateAmount,
      mechanism: "operatorRedemption",
    };
  }
  if (!amountState.shares) return null;
  return { positionId: position.id, shares: amountState.shares, mechanism: "operatorRedemption" };
}

/** The held intermediate is redeemed one-for-one, so its balance is the ceiling. */
function parAvailableAmount(
  position: EarnVaultPosition,
  source: EarnVaultParRedemptionSource
): string | undefined {
  if (source === "shares") return vaultWithdrawalAvailableAmount(position);
  const held = position.parIntermediate?.withdrawableAmount;
  return held !== undefined && isPositiveDecimal(held) ? held : undefined;
}

function parRedemptionAmountState(
  position: EarnVaultPosition,
  amount: string,
  availableAmount: string | undefined,
  terms: EarnVaultParRedemptionTerms,
  source: EarnVaultParRedemptionSource
) {
  const validation = validateVaultWithdrawalAmount(amount);
  const canonical = validation.kind === "valid" ? validation.canonicalAmount : undefined;
  const common = {
    belowBatchMinimum:
      canonical !== undefined &&
      compareUnsignedDecimals(canonical, HASTRA_OPERATOR_BATCH_MINIMUM_USDC) === -1,
    overAvailableAmount:
      canonical !== undefined && availableAmount !== undefined
        ? compareUnsignedDecimals(canonical, availableAmount) === 1
        : false,
  };
  if (source === "intermediate") {
    return {
      ...common,
      belowMinimum:
        canonical !== undefined &&
        compareUnsignedDecimals(canonical, terms.minimumIntermediateAmount) === -1,
      intermediateAmount: canonical,
      shares: undefined,
    };
  }
  const shares =
    canonical === undefined ? undefined : vaultWithdrawalSharesForAmount(canonical, position);
  return {
    ...common,
    // An unavailable rate has no minimum; the preview names it as a blocking issue.
    belowMinimum:
      !!shares &&
      terms.minimumShares !== null &&
      compareUnsignedDecimals(shares, terms.minimumShares) === -1,
    intermediateAmount: undefined,
    shares,
  };
}

function parRedemptionSteps(t: ReturnType<typeof useTranslations>): string[] {
  return withdrawalFlowSteps(t, "DashboardEarn.parRedemption.flowRequested");
}

/**
 * The par route's fingerprint fields: a held-intermediate request carries its
 * own marker, so it never shares a key with a shares request for the same
 * number; a shares request carries its shares.
 */
function parFingerprint(
  input: EarnVaultParRedemptionTermsRequest,
  projectId: string | null
): EarnVaultAsyncWithdrawalIntent {
  return {
    projectId,
    positionId: input.positionId,
    ...(input.intermediateAmount === undefined
      ? { shares: input.shares }
      : { intermediateAmount: input.intermediateAmount }),
    route: { kind: "operator_redemption" },
  };
}

/** The par flow's recovery cancel: the terms' window, on the record itself. */
function isTermsCancelable(terms: EarnVaultParRedemptionTerms) {
  return (request: EarnVaultWithdrawalRequestRecord): boolean =>
    terms.cancelable && isEarnVaultParRedemptionCancelable(request);
}

function ParRedemptionResultDetails({
  environment,
  request,
}: {
  environment: SdpEnvironment;
  request: EarnVaultWithdrawalRequestRecord;
}) {
  const t = useTranslations();
  const locale = useLocale();
  return (
    <DetailList className="mt-5" variant="summary">
      <DetailRow fit="figure" label={t("DashboardEarn.parRedemption.quotedAmount")}>
        <span className="tabular-nums">
          {formatTokenValue(request.quotedAssets, request.assetMint, locale)}
        </span>
      </DetailRow>
      {request.intermediateAmount && request.intermediateMint ? (
        <DetailRow fit="figure" label={t("DashboardEarn.parRedemption.intermediateAmount")}>
          <span className="tabular-nums">
            {formatTokenValue(request.intermediateAmount, request.intermediateMint, locale)}
          </span>
        </DetailRow>
      ) : null}
      {request.creationSignature ? (
        <DetailRow label={t("DashboardEarn.vaultWithdraw.transaction")}>
          <TransactionLink
            cluster={CLUSTER_BY_SDP_ENVIRONMENT[environment]}
            signature={request.creationSignature}
          />
        </DetailRow>
      ) : null}
    </DetailList>
  );
}

function ParRedemptionResult({
  environment,
  onClose,
  onSettled,
  source,
  submitted,
  terms,
}: {
  environment: SdpEnvironment;
  onClose: () => void;
  onSettled?: (request: EarnVaultWithdrawalRequestRecord) => void;
  source: EarnVaultParRedemptionSource;
  submitted: EarnVaultWithdrawalRequestRecord;
  terms: EarnVaultParRedemptionTerms;
}) {
  const t = useTranslations();
  const observed = useEarnVaultWithdrawalRequestOutcome(submitted.withdrawalRequestId, onSettled);
  const { cancel, cancelError, cancelable, cancelling, request } =
    useEarnVaultWithdrawalRequestView({
      submitted,
      observed,
      isCancelable: isTermsCancelable(terms),
    });
  const presentation = earnVaultParRedemptionStatusPresentation(request.status);
  const terminal = isEarnVaultParRedemptionTerminal(request.status);

  return (
    <>
      {terminal ? <EarnOutcomeMark tone={presentation.tone} /> : null}
      <div className="flex items-center gap-3 pr-8">
        <h2 className="text-subheading font-medium text-primary">
          {t("DashboardEarn.parRedemption.resultTitle")}
        </h2>
        <StatusText className="shrink-0 text-body" tone={earnStatusTextTone(presentation.variant)}>
          {t(presentation.labelKey)}
        </StatusText>
      </div>
      <p className="mt-2 text-body text-secondary">{t(presentation.bodyKey)}</p>
      <ParRedemptionResultDetails environment={environment} request={request} />
      {request.status === "failed" && request.failureReason ? (
        <Callout className="mt-4 break-words" live variant="danger">
          {request.failureReason}
        </Callout>
      ) : null}
      {!presentation.terminal ? (
        <div className="mt-4 grid gap-2 text-meta text-tertiary">
          <p>{t(PAR_SOURCE_COPY[source].operatorNotice)}</p>
          <p>{t("DashboardEarn.parRedemption.batchMinimumNotice")}</p>
        </div>
      ) : null}
      {cancelError ? <EarnErrorNote message={cancelError} /> : null}
      <div className="mt-5 flex justify-end gap-2">
        {cancelable ? (
          <Button
            disabled={cancelling}
            iconLeft={
              cancelling ? <Loader2Icon aria-hidden="true" className="animate-spin" /> : null
            }
            onClick={() => void cancel()}
            variant="outline"
          >
            {cancelling
              ? t("DashboardEarn.parRedemption.cancelling")
              : t("DashboardEarn.parRedemption.cancelAction")}
          </Button>
        ) : null}
        <Button onClick={onClose}>{t("DashboardEarn.withdraw.done")}</Button>
      </div>
    </>
  );
}

function ParRedemptionDetails({
  amount,
  availableAmount,
  belowBatchMinimum,
  belowMinimum,
  detailsValid,
  onAmountChange,
  onContinue,
  onMax,
  overAvailableAmount,
  source,
  terms,
  tokenMint,
}: {
  amount: string;
  availableAmount: string | undefined;
  belowBatchMinimum: boolean;
  belowMinimum: boolean;
  detailsValid: boolean;
  onAmountChange: (value: string) => void;
  onContinue: () => void;
  onMax: () => void;
  overAvailableAmount: boolean;
  source: EarnVaultParRedemptionSource;
  terms: EarnVaultParRedemptionTerms;
  tokenMint: string;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const validation = validateVaultWithdrawalAmount(amount);
  const amountInvalid = amount.trim() !== "" && validation.kind !== "valid";
  const copy = PAR_SOURCE_COPY[source];
  const minimum = formatProviderAmount(parMinimum(terms, source), locale, t(copy.unit));
  // A form, so Enter in the amount continues to the review as the button does.
  const continueFromForm = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (detailsValid) onContinue();
  };
  return (
    <form noValidate onSubmit={continueFromForm}>
      <p className="mt-2 text-body text-secondary">{t(copy.detailsBody)}</p>
      <div className="mt-5 grid gap-2">
        <Label htmlFor="earn-par-redemption-amount">
          {t("DashboardEarn.vaultWithdraw.amountLabel")}
        </Label>
        <Input
          action={
            <EarnAmountMaxButton
              disabled={!availableAmount || !isPositiveDecimal(availableAmount)}
              label={t("DashboardEarn.vaultWithdraw.max")}
              onClick={onMax}
            />
          }
          aria-invalid={amountInvalid || belowMinimum ? true : undefined}
          id="earn-par-redemption-amount"
          inputMode="decimal"
          leadingAddon={<span aria-hidden="true">$</span>}
          maxDecimals={VAULT_WITHDRAWAL_AMOUNT_DECIMALS}
          onChange={(event: ChangeEvent<HTMLInputElement>) => onAmountChange(event.target.value)}
          placeholder="0.00"
          value={amount}
        />
        <p className="text-meta text-tertiary">
          {availableAmount
            ? t("DashboardEarn.vaultWithdraw.amountAvailable", {
                amount: formatTokenValue(availableAmount, tokenMint, locale),
              })
            : t("DashboardEarn.vaultWithdraw.amountUnavailable")}
        </p>
        {amountInvalid ? (
          <p className="text-meta text-error" role="alert">
            {t("DashboardEarn.vaultWithdraw.amountInvalid")}
          </p>
        ) : belowMinimum ? (
          <p className="text-meta text-error" role="alert">
            {t("DashboardEarn.parRedemption.minimumShares", { amount: minimum })}
          </p>
        ) : overAvailableAmount ? (
          <p className="text-meta text-warning" role="status">
            {t("DashboardEarn.vaultWithdraw.overAmount")}
          </p>
        ) : null}
        {belowBatchMinimum ? (
          <p className="text-meta text-warning" role="status">
            {t("DashboardEarn.parRedemption.belowBatchMinimum")}
          </p>
        ) : null}
      </div>
      <div className="mt-4 grid gap-2 text-meta text-tertiary">
        <p>{t(copy.operatorNotice)}</p>
        <p>{t("DashboardEarn.parRedemption.batchMinimumNotice")}</p>
      </div>
      <div className="mt-6">
        <Button className="!w-full" disabled={!detailsValid} type="submit">
          {t("DashboardEarn.deposit.continueAction")}
        </Button>
      </div>
    </form>
  );
}

function ParRedemptionReview({
  error,
  loading,
  onBack,
  onSubmit,
  preview,
  source,
  submitting,
}: {
  error: string | null;
  loading: boolean;
  onBack: () => void;
  onSubmit: () => void;
  preview: EarnVaultParRedemptionPreview | null;
  source: EarnVaultParRedemptionSource;
  submitting: boolean;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const belowBatchMinimum =
    preview !== null &&
    compareUnsignedDecimals(preview.assets, HASTRA_OPERATOR_BATCH_MINIMUM_USDC) === -1;
  return (
    <>
      <p className="mt-1 text-body text-secondary">{t(PAR_SOURCE_COPY[source].reviewBody)}</p>
      {loading ? (
        <div className="mt-5 flex items-center gap-2 text-body text-secondary" role="status">
          <Loader2Icon aria-hidden="true" className="size-4 animate-spin" />
          {t("DashboardEarn.parRedemption.previewLoading")}
        </div>
      ) : preview ? (
        <DetailList className="mt-5" variant="summary">
          <DetailRow fit="figure" label={t("DashboardEarn.parRedemption.expectedAmount")}>
            <span className="tabular-nums">
              {formatTokenValue(preview.assets, preview.assetMint, locale)}
            </span>
          </DetailRow>
          <DetailRow fit="figure" label={t("DashboardEarn.parRedemption.intermediateAmount")}>
            <span className="tabular-nums">
              {formatTokenValue(preview.intermediateAmount, preview.intermediateMint, locale)}
            </span>
          </DetailRow>
        </DetailList>
      ) : null}
      {preview && preview.blockingIssues.length > 0 ? (
        <Callout
          className="mt-4"
          live
          title={t("DashboardEarn.parRedemption.previewBlocked")}
          variant="warning"
        >
          <ul className="list-disc space-y-1 pl-5">
            {preview.blockingIssues.map((issue) => (
              <li key={`${issue.code}:${issue.message}`}>{issue.message}</li>
            ))}
          </ul>
        </Callout>
      ) : null}
      {belowBatchMinimum ? (
        <Callout className="mt-4" live variant="warning">
          {t("DashboardEarn.parRedemption.belowBatchMinimum")}
        </Callout>
      ) : null}
      <p className="mt-4 text-meta text-tertiary">{t(PAR_SOURCE_COPY[source].reviewNotice)}</p>
      {error ? <EarnErrorNote message={error} /> : null}
      <div className="mt-6 flex gap-2">
        <Button className="flex-1" disabled={submitting} onClick={onBack} variant="outline">
          {t("DashboardEarn.deposit.back")}
        </Button>
        <Button
          className="flex-[2]"
          disabled={submitting || loading || !preview || preview.blockingIssues.length > 0}
          iconLeft={submitting ? <Loader2Icon aria-hidden="true" className="animate-spin" /> : null}
          onClick={onSubmit}
        >
          {submitting
            ? t("DashboardEarn.parRedemption.submitting")
            : t("DashboardEarn.parRedemption.submit")}
        </Button>
      </div>
    </>
  );
}

function ParRedemptionForm({
  amount,
  availableAmount,
  belowBatchMinimum,
  belowMinimum,
  detailsValid,
  error,
  loading,
  modalLabel,
  onAmountChange,
  onBack,
  onContinue,
  onMax,
  onSubmit,
  overAvailableAmount,
  preview,
  source,
  step,
  submitting,
  terms,
  tokenMint,
}: {
  amount: string;
  availableAmount: string | undefined;
  belowBatchMinimum: boolean;
  belowMinimum: boolean;
  detailsValid: boolean;
  error: string | null;
  loading: boolean;
  modalLabel: string;
  onAmountChange: (value: string) => void;
  onBack: () => void;
  onContinue: () => void;
  onMax: () => void;
  onSubmit: () => void;
  overAvailableAmount: boolean;
  preview: EarnVaultParRedemptionPreview | null;
  source: EarnVaultParRedemptionSource;
  step: FormStep;
  submitting: boolean;
  terms: EarnVaultParRedemptionTerms;
  tokenMint: string;
}) {
  return (
    <>
      <h2
        className="pr-8 text-subheading font-medium text-primary"
        data-modal-focus-target
        tabIndex={-1}
      >
        {modalLabel}
      </h2>
      {step === "details" ? (
        <ParRedemptionDetails
          amount={amount}
          availableAmount={availableAmount}
          belowBatchMinimum={belowBatchMinimum}
          belowMinimum={belowMinimum}
          detailsValid={detailsValid}
          onAmountChange={onAmountChange}
          onContinue={onContinue}
          onMax={onMax}
          overAvailableAmount={overAvailableAmount}
          source={source}
          terms={terms}
          tokenMint={tokenMint}
        />
      ) : (
        <ParRedemptionReview
          error={error}
          loading={loading}
          onBack={onBack}
          onSubmit={onSubmit}
          preview={preview}
          source={source}
          submitting={submitting}
        />
      )}
    </>
  );
}

export function EarnVaultParRedemptionModal({
  environment,
  onClose,
  onRequested,
  onSubmissionStart,
  onSettled,
  position,
  projectId,
  source = "shares",
  terms,
}: EarnVaultParRedemptionModalProps) {
  const t = useTranslations();
  const [step, setStep] = useState<FormStep>("details");
  const [amount, setAmount] = useState("");
  const availableAmount = parAvailableAmount(position, source);
  const amountState = parRedemptionAmountState(position, amount, availableAmount, terms, source);
  const { belowMinimum, intermediateAmount, overAvailableAmount, shares } = amountState;
  const input = useMemo(
    () =>
      parPreviewInput(position, { belowMinimum, intermediateAmount, overAvailableAmount, shares }),
    [position, belowMinimum, intermediateAmount, overAvailableAmount, shares]
  );
  const {
    preview,
    previewLoading: loading,
    error,
    setError,
  } = useEarnVaultWithdrawalPreview(
    fetchEarnVaultParRedemptionPreview,
    input,
    step === "review",
    "DashboardEarn.parRedemption.previewError"
  );
  const { submitting, outcome, submit } = useEarnVaultWithdrawalSubmission({
    onSubmissionStart,
    custodyWalletId: position.custodyWalletId,
    onRequested,
    projectId,
    setError,
    fingerprintFor: parFingerprint,
  });
  const positionName = positionDisplayName(position);
  const modalLabel = t(PAR_SOURCE_COPY[source].title, { position: positionName });

  return (
    <Modal
      isOpen
      ariaLabel={modalLabel}
      closeDisabled={submitting}
      onClose={onClose}
      {...EARN_TRANSACTION_MODAL_FRAME}
    >
      <div className="p-6">
        <EarnFlowStepper
          currentStep={withdrawalFlowStepIndex(outcome, step)}
          steps={parRedemptionSteps(t)}
        />
        <EarnFlowTransition stepKey={withdrawalFlowStepKey(outcome, step)}>
          {outcome ? (
            <ParRedemptionResult
              environment={environment}
              onClose={onClose}
              onSettled={onSettled}
              source={source}
              submitted={outcome.withdrawalRequest}
              terms={terms}
            />
          ) : (
            <ParRedemptionForm
              amount={amount}
              availableAmount={availableAmount}
              belowBatchMinimum={amountState.belowBatchMinimum}
              belowMinimum={amountState.belowMinimum}
              detailsValid={input !== null}
              error={error}
              loading={loading}
              modalLabel={modalLabel}
              onAmountChange={setAmount}
              onBack={() => setStep("details")}
              onContinue={() => setStep("review")}
              onMax={() => {
                if (availableAmount) setAmount(availableAmount);
              }}
              onSubmit={() => void submit(input, preview)}
              overAvailableAmount={amountState.overAvailableAmount}
              preview={preview}
              source={source}
              step={step}
              submitting={submitting}
              terms={terms}
              tokenMint={position.tokenMint}
            />
          )}
        </EarnFlowTransition>
      </div>
    </Modal>
  );
}
