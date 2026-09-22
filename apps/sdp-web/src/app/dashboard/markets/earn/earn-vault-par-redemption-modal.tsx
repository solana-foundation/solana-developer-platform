"use client";

import {
  CLUSTER_BY_SDP_ENVIRONMENT,
  type EarnVaultParRedemptionPreview,
  type EarnVaultParRedemptionTerms,
  type EarnVaultParRedemptionTermsRequest,
  type EarnVaultPosition,
  type EarnVaultWithdrawalRequestRecord,
  type SdpEnvironment,
} from "@sdp/types";
import { Loader2Icon } from "lucide-react";
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { useLocale, useTranslations } from "@/i18n/provider";
import { applyIdempotencyKeyOutcome } from "@/lib/idempotency-key-store";
import { EarnAmountMaxButton } from "./earn-amount-max-button";
import { compareUnsignedDecimals, isPositiveDecimal } from "./earn-decimal";
import { EarnFlowStepper, EarnFlowTransition, EarnOutcomeMark } from "./earn-flow-motion";
import { formatProviderAmount, formatUsd, shortenMarketAddress } from "./earn-format";
import { earnMintAsset, TransactionLink } from "./earn-market-presentation";
import {
  cancelEarnVaultWithdrawalRequest,
  createEarnVaultWithdrawalRequest,
  type EarnVaultQueuedWithdrawalOutcome,
  fetchEarnVaultParRedemptionPreview,
  useEarnVaultWithdrawalRequestOutcome,
} from "./earn-program-data";
import { EarnVaultApprovalResult } from "./earn-vault-approval-result";
import {
  vaultAsyncWithdrawalIdempotencyKeyStore,
  vaultAsyncWithdrawalRequestFingerprint,
} from "./earn-vault-async-withdrawal-tracking";
import {
  earnVaultParRedemptionStatusPresentation,
  isEarnVaultParRedemptionCancelable,
  isEarnVaultParRedemptionTerminal,
} from "./earn-vault-par-redemption-presentation";
import {
  VAULT_WITHDRAWAL_AMOUNT_DECIMALS,
  validateVaultWithdrawalAmount,
  vaultWithdrawalAvailableAmount,
  vaultWithdrawalSharesForAmount,
} from "./earn-vault-withdraw-amount";

interface EarnVaultParRedemptionModalProps {
  environment: SdpEnvironment;
  onClose: () => void;
  onRequested?: (request: EarnVaultWithdrawalRequestRecord) => void;
  onSettled?: (request: EarnVaultWithdrawalRequestRecord) => void;
  position: EarnVaultPosition;
  projectId: string | null;
  terms: EarnVaultParRedemptionTerms;
}

type FormStep = "details" | "review";

// Hastra documents this off-chain operator/CCTP batching threshold. It is an
// advisory, not a program rule: v0.0.6 accepts a one-atom request, so the UI
// must disclose the operational risk without misrepresenting it as on-chain.
const HASTRA_OPERATOR_BATCH_MINIMUM_USDC = "2000";

function parPreviewInput(
  position: EarnVaultPosition,
  shares: string | undefined,
  terms: EarnVaultParRedemptionTerms
): EarnVaultParRedemptionTermsRequest | null {
  if (!shares || compareUnsignedDecimals(shares, terms.minimumShares) === -1) return null;
  return { positionId: position.id, shares, mechanism: "operatorRedemption" };
}

function isClientErrorStatus(status: number | null): boolean {
  return status !== null && status >= 400 && status < 500;
}

function parRedemptionAmountState(
  position: EarnVaultPosition,
  amount: string,
  availableAmount: string | undefined,
  terms: EarnVaultParRedemptionTerms
) {
  const validation = validateVaultWithdrawalAmount(amount);
  const shares =
    validation.kind === "valid"
      ? vaultWithdrawalSharesForAmount(validation.canonicalAmount, position)
      : undefined;
  return {
    belowBatchMinimum:
      validation.kind === "valid" &&
      compareUnsignedDecimals(validation.canonicalAmount, HASTRA_OPERATOR_BATCH_MINIMUM_USDC) ===
        -1,
    belowMinimum: !!shares && compareUnsignedDecimals(shares, terms.minimumShares) === -1,
    overAvailableAmount:
      validation.kind === "valid" && availableAmount !== undefined
        ? compareUnsignedDecimals(validation.canonicalAmount, availableAmount) === 1
        : false,
    shares,
  };
}

function parRedemptionSteps(
  outcome: EarnVaultQueuedWithdrawalOutcome | null,
  t: ReturnType<typeof useTranslations>
): string[] {
  return [
    t("DashboardEarn.vaultWithdraw.flowDetails"),
    t("DashboardEarn.vaultWithdraw.flowReview"),
    outcome?.kind === "approval_pending"
      ? t("DashboardEarn.queuedWithdraw.flowApproval")
      : t("DashboardEarn.parRedemption.flowRequested"),
  ];
}

function parRedemptionStepIndex(
  outcome: EarnVaultQueuedWithdrawalOutcome | null,
  step: FormStep
): number {
  if (outcome) return 2;
  return step === "review" ? 1 : 0;
}

function parRedemptionStepKey(outcome: EarnVaultQueuedWithdrawalOutcome | null, step: FormStep) {
  return outcome ? `result:${outcome.kind}` : step;
}

function freshCancelRecord(
  cancelResult: EarnVaultWithdrawalRequestRecord | null,
  observed: EarnVaultWithdrawalRequestRecord | undefined,
  submitted: EarnVaultWithdrawalRequestRecord
): EarnVaultWithdrawalRequestRecord {
  if (cancelResult === null) return observed ?? submitted;
  if (!observed || Date.parse(cancelResult.updatedAt) >= Date.parse(observed.updatedAt)) {
    return cancelResult;
  }
  return observed;
}

function useParRedemptionPreview(
  input: EarnVaultParRedemptionTermsRequest | null,
  active: boolean
) {
  const t = useTranslations();
  const [preview, setPreview] = useState<EarnVaultParRedemptionPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active || !input) return;
    const controller = new AbortController();
    setPreview(null);
    setLoading(true);
    setError(null);
    void fetchEarnVaultParRedemptionPreview(input, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.kind === "ready") setPreview(result.value);
        else setError(t("DashboardEarn.parRedemption.previewError"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [active, input, t]);

  return { preview, loading, error, setError };
}

function useParRedemptionSubmission(options: {
  onRequested?: (request: EarnVaultWithdrawalRequestRecord) => void;
  projectId: string | null;
  setError: (error: string | null) => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<EarnVaultQueuedWithdrawalOutcome | null>(null);

  async function submit(
    input: EarnVaultParRedemptionTermsRequest | null,
    preview: EarnVaultParRedemptionPreview | null
  ) {
    if (!input || !preview || preview.blockingIssues.length > 0) return;
    setSubmitting(true);
    options.setError(null);
    try {
      const fingerprint = vaultAsyncWithdrawalRequestFingerprint({
        projectId: options.projectId,
        positionId: input.positionId,
        shares: input.shares,
        route: { kind: "operator_redemption" },
      });
      const result = await createEarnVaultWithdrawalRequest(
        input,
        vaultAsyncWithdrawalIdempotencyKeyStore.claim(fingerprint)
      );
      applyIdempotencyKeyOutcome(vaultAsyncWithdrawalIdempotencyKeyStore, fingerprint, result);
      if (result.ok) {
        setOutcome(result.data);
        if (result.data.kind === "submitted") options.onRequested?.(result.data.withdrawalRequest);
      } else {
        options.setError(result.error);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return { submitting, outcome, submit };
}

/**
 * Owns the settled-request view model: local cancellation state wins only
 * until server polling reports a record at least as fresh, and the recovery
 * cancel action reuses one idempotency key per ambiguous transport attempt.
 */
function useParRedemptionRequestView(
  submitted: EarnVaultWithdrawalRequestRecord,
  observed: EarnVaultWithdrawalRequestRecord | undefined,
  cancelAllowed: boolean
) {
  const [cancelResult, setCancelResult] = useState<EarnVaultWithdrawalRequestRecord | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const cancelKey = useRef<string | null>(null);
  const request = freshCancelRecord(cancelResult, observed, submitted);
  const cancelable = cancelAllowed && isEarnVaultParRedemptionCancelable(request);

  async function cancel() {
    if (!cancelable || cancelling) return;
    setCancelling(true);
    setCancelError(null);
    cancelKey.current ??= crypto.randomUUID();
    try {
      const result = await cancelEarnVaultWithdrawalRequest(
        request.withdrawalRequestId,
        cancelKey.current
      );
      if (result.ok) {
        cancelKey.current = null;
        setCancelResult(result.data);
      } else {
        if (isClientErrorStatus(result.status)) {
          cancelKey.current = null;
        }
        setCancelError(result.error);
      }
    } finally {
      setCancelling(false);
    }
  }

  return { cancel, cancelError, cancelable, cancelling, request };
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
    <dl className="mt-5 grid gap-3 rounded-xl bg-fill-subtle px-4 py-3 text-sm">
      <div className="flex items-baseline justify-between gap-5">
        <dt className="text-tertiary">{t("DashboardEarn.parRedemption.quotedAmount")}</dt>
        <dd className="text-right tabular-nums text-primary">
          {formatProviderAmount(
            request.quotedAssets,
            locale,
            earnMintAsset(request.assetMint).symbol
          )}
        </dd>
      </div>
      {request.intermediateAmount && request.intermediateMint ? (
        <div className="flex items-baseline justify-between gap-5">
          <dt className="text-tertiary">{t("DashboardEarn.parRedemption.intermediateAmount")}</dt>
          <dd className="text-right tabular-nums text-primary">
            {formatProviderAmount(
              request.intermediateAmount,
              locale,
              earnMintAsset(request.intermediateMint).symbol
            )}
          </dd>
        </div>
      ) : null}
      {request.creationSignature ? (
        <div className="flex items-baseline justify-between gap-5">
          <dt className="text-tertiary">{t("DashboardEarn.vaultWithdraw.transaction")}</dt>
          <dd className="text-right">
            <TransactionLink
              cluster={CLUSTER_BY_SDP_ENVIRONMENT[environment]}
              signature={request.creationSignature}
            />
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

function ParRedemptionResult({
  environment,
  onClose,
  onSettled,
  submitted,
  terms,
}: {
  environment: SdpEnvironment;
  onClose: () => void;
  onSettled?: (request: EarnVaultWithdrawalRequestRecord) => void;
  submitted: EarnVaultWithdrawalRequestRecord;
  terms: EarnVaultParRedemptionTerms;
}) {
  const t = useTranslations();
  const observed = useEarnVaultWithdrawalRequestOutcome(submitted.withdrawalRequestId, onSettled);
  const { cancel, cancelError, cancelable, cancelling, request } = useParRedemptionRequestView(
    submitted,
    observed,
    terms.cancelable
  );
  const presentation = earnVaultParRedemptionStatusPresentation(request.status);
  const terminal = isEarnVaultParRedemptionTerminal(request.status);

  return (
    <>
      {terminal ? <EarnOutcomeMark tone={presentation.tone} /> : null}
      <div className="flex items-center gap-2 pr-8">
        <h2 className="text-base font-medium text-primary">
          {t("DashboardEarn.parRedemption.resultTitle")}
        </h2>
        <Badge variant={presentation.variant}>{t(presentation.labelKey)}</Badge>
      </div>
      <p className="mt-2 text-sm leading-5 text-secondary">{t(presentation.bodyKey)}</p>
      <ParRedemptionResultDetails environment={environment} request={request} />
      {request.status === "failed" && request.failureReason ? (
        <div
          className="mt-4 rounded-lg border border-destructive-border bg-destructive-bg p-3 text-sm text-error"
          role="alert"
        >
          {request.failureReason}
        </div>
      ) : null}
      {!presentation.terminal ? (
        <div className="mt-4 grid gap-2 text-xs leading-5 text-tertiary">
          <p>{t("DashboardEarn.parRedemption.operatorNotice")}</p>
          <p>{t("DashboardEarn.parRedemption.batchMinimumNotice")}</p>
        </div>
      ) : null}
      {cancelError ? (
        <p
          className="mt-3 rounded-lg border border-destructive-border bg-destructive-bg p-3 text-sm text-error"
          role="alert"
        >
          {cancelError}
        </p>
      ) : null}
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
  terms,
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
  terms: EarnVaultParRedemptionTerms;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const validation = validateVaultWithdrawalAmount(amount);
  const amountInvalid = amount.trim() !== "" && validation.kind !== "valid";
  return (
    <>
      <p className="mt-2 text-sm leading-5 text-secondary">
        {t("DashboardEarn.parRedemption.detailsBody")}
      </p>
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
        <p className="text-xs text-tertiary">
          {availableAmount
            ? t("DashboardEarn.vaultWithdraw.amountAvailable", {
                amount: formatUsd(availableAmount, locale),
              })
            : t("DashboardEarn.vaultWithdraw.amountUnavailable")}
        </p>
        {amountInvalid ? (
          <p className="text-xs text-error" role="alert">
            {t("DashboardEarn.vaultWithdraw.amountInvalid")}
          </p>
        ) : belowMinimum ? (
          <p className="text-xs text-error" role="alert">
            {t("DashboardEarn.parRedemption.minimumShares", {
              amount: formatProviderAmount(
                terms.minimumShares,
                locale,
                t("DashboardEarn.parRedemption.shareUnit")
              ),
            })}
          </p>
        ) : overAvailableAmount ? (
          <p className="text-xs text-warning" role="status">
            {t("DashboardEarn.vaultWithdraw.overAmount")}
          </p>
        ) : null}
        {belowBatchMinimum ? (
          <p className="text-xs leading-5 text-warning" role="status">
            {t("DashboardEarn.parRedemption.belowBatchMinimum")}
          </p>
        ) : null}
      </div>
      <div className="mt-4 grid gap-2 text-xs leading-5 text-tertiary">
        <p>{t("DashboardEarn.parRedemption.operatorNotice")}</p>
        <p>{t("DashboardEarn.parRedemption.batchMinimumNotice")}</p>
      </div>
      <div className="mt-6">
        <Button className="!w-full" disabled={!detailsValid} onClick={onContinue}>
          {t("DashboardEarn.deposit.continueAction")}
        </Button>
      </div>
    </>
  );
}

function ParRedemptionReview({
  error,
  loading,
  onBack,
  onSubmit,
  preview,
  submitting,
}: {
  error: string | null;
  loading: boolean;
  onBack: () => void;
  onSubmit: () => void;
  preview: EarnVaultParRedemptionPreview | null;
  submitting: boolean;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const belowBatchMinimum =
    preview !== null &&
    compareUnsignedDecimals(preview.assets, HASTRA_OPERATOR_BATCH_MINIMUM_USDC) === -1;
  return (
    <>
      <p className="mt-1 text-sm text-secondary">{t("DashboardEarn.parRedemption.reviewBody")}</p>
      {loading ? (
        <div className="mt-5 flex items-center gap-2 text-sm text-secondary" role="status">
          <Loader2Icon aria-hidden="true" className="size-4 animate-spin" />
          {t("DashboardEarn.parRedemption.previewLoading")}
        </div>
      ) : preview ? (
        <dl className="mt-5 grid gap-3 rounded-xl bg-fill-subtle px-4 py-3 text-sm">
          <div className="flex items-baseline justify-between gap-5">
            <dt className="text-tertiary">{t("DashboardEarn.parRedemption.expectedAmount")}</dt>
            <dd className="text-right tabular-nums text-primary">
              {formatProviderAmount(
                preview.assets,
                locale,
                earnMintAsset(preview.assetMint).symbol
              )}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-5">
            <dt className="text-tertiary">{t("DashboardEarn.parRedemption.intermediateAmount")}</dt>
            <dd className="text-right tabular-nums text-primary">
              {formatProviderAmount(
                preview.intermediateAmount,
                locale,
                earnMintAsset(preview.intermediateMint).symbol
              )}
            </dd>
          </div>
        </dl>
      ) : null}
      {preview && preview.blockingIssues.length > 0 ? (
        <div
          className="mt-4 rounded-lg border border-warning-border bg-warning-bg p-3 text-sm text-warning"
          role="alert"
        >
          <p>{t("DashboardEarn.parRedemption.previewBlocked")}</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {preview.blockingIssues.map((issue) => (
              <li key={`${issue.code}:${issue.message}`}>{issue.message}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {belowBatchMinimum ? (
        <p
          className="mt-4 rounded-lg border border-warning-border bg-warning-bg p-3 text-sm text-warning"
          role="alert"
        >
          {t("DashboardEarn.parRedemption.belowBatchMinimum")}
        </p>
      ) : null}
      <p className="mt-4 text-xs leading-5 text-tertiary">
        {t("DashboardEarn.parRedemption.reviewNotice")}
      </p>
      {error ? (
        <p
          className="mt-3 rounded-lg border border-destructive-border bg-destructive-bg p-3 text-sm text-error"
          role="alert"
        >
          {error}
        </p>
      ) : null}
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

function ParRedemptionApprovalResult({
  onClose,
  outcome,
}: {
  onClose: () => void;
  outcome: Extract<EarnVaultQueuedWithdrawalOutcome, { kind: "approval_pending" }>;
}) {
  return (
    <EarnVaultApprovalResult
      approvalRequestId={outcome.approvalRequestId}
      onClose={onClose}
      walletOperationId={outcome.walletOperationId}
    />
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
  step,
  submitting,
  terms,
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
  step: FormStep;
  submitting: boolean;
  terms: EarnVaultParRedemptionTerms;
}) {
  return (
    <>
      <h2
        className="pr-8 text-lg font-medium leading-6 text-primary"
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
          terms={terms}
        />
      ) : (
        <ParRedemptionReview
          error={error}
          loading={loading}
          onBack={onBack}
          onSubmit={onSubmit}
          preview={preview}
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
  onSettled,
  position,
  projectId,
  terms,
}: EarnVaultParRedemptionModalProps) {
  const t = useTranslations();
  const [step, setStep] = useState<FormStep>("details");
  const [amount, setAmount] = useState("");
  const availableAmount = vaultWithdrawalAvailableAmount(position);
  const amountState = parRedemptionAmountState(position, amount, availableAmount, terms);
  const input = useMemo(
    () => parPreviewInput(position, amountState.shares, terms),
    [position, amountState.shares, terms]
  );
  const { preview, loading, error, setError } = useParRedemptionPreview(input, step === "review");
  const { submitting, outcome, submit } = useParRedemptionSubmission({
    onRequested,
    projectId,
    setError,
  });
  const positionName = position.label || shortenMarketAddress(position.providerReference);
  const modalLabel = t("DashboardEarn.parRedemption.title", { position: positionName });

  return (
    <Modal isOpen ariaLabel={modalLabel} closeDisabled={submitting} onClose={onClose} size="md">
      <div className="p-6">
        <EarnFlowStepper
          currentStep={parRedemptionStepIndex(outcome, step)}
          steps={parRedemptionSteps(outcome, t)}
        />
        <EarnFlowTransition stepKey={parRedemptionStepKey(outcome, step)}>
          {outcome?.kind === "approval_pending" ? (
            <ParRedemptionApprovalResult onClose={onClose} outcome={outcome} />
          ) : outcome?.kind === "submitted" ? (
            <ParRedemptionResult
              environment={environment}
              onClose={onClose}
              onSettled={onSettled}
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
              step={step}
              submitting={submitting}
              terms={terms}
            />
          )}
        </EarnFlowTransition>
      </div>
    </Modal>
  );
}
