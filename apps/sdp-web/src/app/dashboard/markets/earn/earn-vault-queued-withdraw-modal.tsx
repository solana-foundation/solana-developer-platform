"use client";

import {
  CLUSTER_BY_SDP_ENVIRONMENT,
  type EarnVaultPosition,
  type EarnVaultQueuedWithdrawalPreview,
  type EarnVaultQueuedWithdrawalTerms,
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
import { isPositiveDecimal } from "./earn-decimal";
import { EarnFlowStepper, EarnFlowTransition, EarnOutcomeMark } from "./earn-flow-motion";
import { formatEpochSeconds, formatTokenQuantity, formatUsd } from "./earn-format";
import { earnMintAsset, shortenMarketAddress, TransactionLink } from "./earn-market-presentation";
import {
  cancelEarnVaultWithdrawalRequest,
  createEarnVaultWithdrawalRequest,
  type EarnVaultQueuedWithdrawalOutcome,
  fetchEarnVaultQueuedWithdrawalPreview,
  useEarnVaultWithdrawalRequestOutcome,
} from "./earn-program-data";
import {
  vaultAsyncWithdrawalIdempotencyKeyStore,
  vaultAsyncWithdrawalRequestFingerprint,
} from "./earn-vault-async-withdrawal-tracking";
import {
  earnVaultQueuedWithdrawalStatusPresentation,
  isEarnVaultQueuedWithdrawalTerminal,
} from "./earn-vault-queued-withdrawal-presentation";
import {
  validateVaultWithdrawalAmount,
  vaultWithdrawalAvailableAmount,
  vaultWithdrawalSharesForAmount,
} from "./earn-vault-withdraw-amount";

interface QueuedWithdrawalModalProps {
  environment: SdpEnvironment;
  onClose: () => void;
  onRequested?: (request: EarnVaultWithdrawalRequestRecord) => void;
  onSettled?: (request: EarnVaultWithdrawalRequestRecord) => void;
  position: EarnVaultPosition;
  projectId: string | null;
  terms: EarnVaultQueuedWithdrawalTerms;
}

type FormStep = "details" | "review";

function epochDate(value: string, locale: string): string {
  return formatEpochSeconds(value, locale) ?? "—";
}

function QueuedWithdrawalResult({
  environment,
  onClose,
  onSettled,
  request: submitted,
}: {
  environment: SdpEnvironment;
  onClose: () => void;
  onSettled?: (request: EarnVaultWithdrawalRequestRecord) => void;
  request: EarnVaultWithdrawalRequestRecord;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const observed = useEarnVaultWithdrawalRequestOutcome(submitted.withdrawalRequestId, onSettled);
  const [cancelResult, setCancelResult] = useState<EarnVaultWithdrawalRequestRecord | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const cancelKey = useRef<string | null>(null);
  useEffect(() => {
    if (cancelResult && observed && observed.updatedAt > cancelResult.updatedAt) {
      setCancelResult(null);
    }
  }, [cancelResult, observed]);
  const request = cancelResult ?? observed ?? submitted;
  const presentation = earnVaultQueuedWithdrawalStatusPresentation(request.status);
  const terminal = isEarnVaultQueuedWithdrawalTerminal(request.status);

  async function cancel() {
    if (cancelling || request.status !== "expiredCancelable") return;
    setCancelling(true);
    setCancelError(null);
    cancelKey.current ??= crypto.randomUUID();
    const result = await cancelEarnVaultWithdrawalRequest(
      request.withdrawalRequestId,
      cancelKey.current
    );
    if (result.ok) {
      // A parsed 2xx definitively consumed this action key. Render its returned
      // `cancelling` state until polling advances; if reconciliation later
      // reopens recovery, the next attempt must use a fresh key and transaction.
      cancelKey.current = null;
      setCancelResult(result.data);
    } else {
      // A 4xx definitively wrote no new action under this key. Preserve keys
      // only for transport/5xx ambiguity, where the API may have recorded it.
      if (result.status !== null && result.status >= 400 && result.status < 500) {
        cancelKey.current = null;
      }
      setCancelError(result.error);
    }
    setCancelling(false);
  }

  return (
    <>
      {terminal ? <EarnOutcomeMark tone={presentation.tone} /> : null}
      <div className="flex items-center gap-2 pr-8">
        <h2
          className="text-base font-medium text-primary outline-none"
          data-modal-focus-target
          tabIndex={-1}
        >
          {t("DashboardEarn.queuedWithdraw.resultTitle")}
        </h2>
        <Badge variant={presentation.variant}>{t(presentation.labelKey)}</Badge>
      </div>
      <p className="mt-2 text-sm leading-5 text-secondary">{t(presentation.bodyKey)}</p>

      <dl className="mt-5 grid gap-3 rounded-xl bg-fill-subtle px-4 py-3 text-sm">
        <div className="flex items-baseline justify-between gap-5">
          <dt className="text-tertiary">{t("DashboardEarn.queuedWithdraw.quotedAmount")}</dt>
          <dd className="text-right tabular-nums text-primary">
            {formatTokenQuantity(
              request.quotedAssets,
              locale,
              earnMintAsset(request.assetMint).symbol
            )}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-5">
          <dt className="text-tertiary">{t("DashboardEarn.queuedWithdraw.maturity")}</dt>
          <dd className="text-right text-primary">
            {epochDate(request.maturityTimestamp, locale)}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-5">
          <dt className="text-tertiary">{t("DashboardEarn.queuedWithdraw.deadline")}</dt>
          <dd className="text-right text-primary">
            {epochDate(request.deadlineTimestamp, locale)}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-5">
          <dt className="text-tertiary">{t("DashboardEarn.queuedWithdraw.requestAccount")}</dt>
          <dd className="max-w-56 break-all text-right text-primary">{request.requestAddress}</dd>
        </div>
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

      {request.status === "failed" && request.failureReason ? (
        <div
          className="mt-4 rounded-lg border border-destructive-border bg-destructive-bg p-3 text-sm text-error"
          role="alert"
        >
          <p className="font-medium">{t("DashboardEarn.queuedWithdraw.failureReason")}</p>
          <p className="mt-1 break-words">{request.failureReason}</p>
        </div>
      ) : null}

      {request.status === "expiredCancelable" ? (
        <p className="mt-4 text-xs leading-5 text-warning">
          {t("DashboardEarn.queuedWithdraw.recoveryReady")}
        </p>
      ) : presentation.awaitingProvider ? (
        <p className="mt-4 text-xs leading-5 text-tertiary">
          {t("DashboardEarn.queuedWithdraw.solverNotice")}
        </p>
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
        {request.status === "expiredCancelable" ? (
          <Button
            disabled={cancelling}
            iconLeft={
              cancelling ? <Loader2Icon aria-hidden="true" className="animate-spin" /> : null
            }
            onClick={() => void cancel()}
            variant="outline"
          >
            {cancelling
              ? t("DashboardEarn.queuedWithdraw.cancelling")
              : t("DashboardEarn.queuedWithdraw.cancelAction")}
          </Button>
        ) : null}
        <Button onClick={onClose}>{t("DashboardEarn.withdraw.done")}</Button>
      </div>
    </>
  );
}

function QueuedWithdrawalApprovalResult({
  onClose,
  outcome,
}: {
  onClose: () => void;
  outcome: Extract<EarnVaultQueuedWithdrawalOutcome, { kind: "approval_pending" }>;
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

function QueueReview({
  error,
  loading,
  onBack,
  onSubmit,
  position,
  preview,
  submitting,
}: {
  error: string | null;
  loading: boolean;
  onBack: () => void;
  onSubmit: () => void;
  position: EarnVaultPosition;
  preview: EarnVaultQueuedWithdrawalPreview | null;
  submitting: boolean;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const symbol = earnMintAsset(position.tokenMint).symbol;
  return (
    <>
      <p className="mt-1 text-sm text-secondary">{t("DashboardEarn.queuedWithdraw.reviewBody")}</p>
      {loading ? (
        <div className="mt-5 flex items-center gap-2 text-sm text-secondary" role="status">
          <Loader2Icon aria-hidden="true" className="size-4 animate-spin" />
          {t("DashboardEarn.queuedWithdraw.previewLoading")}
        </div>
      ) : preview ? (
        <dl className="mt-5 grid gap-3 rounded-xl bg-fill-subtle px-4 py-3 text-sm">
          <div className="flex items-baseline justify-between gap-5">
            <dt className="text-tertiary">{t("DashboardEarn.queuedWithdraw.expectedAmount")}</dt>
            <dd className="text-right tabular-nums text-primary">
              {formatTokenQuantity(preview.assets, locale, symbol)}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-5">
            <dt className="text-tertiary">{t("DashboardEarn.queuedWithdraw.discount")}</dt>
            <dd className="text-right text-primary">{preview.discountBps} bps</dd>
          </div>
          <div className="flex items-baseline justify-between gap-5">
            <dt className="text-tertiary">{t("DashboardEarn.queuedWithdraw.maturity")}</dt>
            <dd className="text-right text-primary">
              {epochDate(preview.maturityTimestamp, locale)}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-5">
            <dt className="text-tertiary">{t("DashboardEarn.queuedWithdraw.deadline")}</dt>
            <dd className="text-right text-primary">
              {epochDate(preview.deadlineTimestamp, locale)}
            </dd>
          </div>
        </dl>
      ) : null}
      {preview && preview.blockingIssues.length > 0 ? (
        <div
          className="mt-4 rounded-lg border border-warning-border bg-warning-bg p-3 text-sm text-warning"
          role="alert"
        >
          <p>{t("DashboardEarn.queuedWithdraw.previewBlocked")}</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {preview.blockingIssues.map((issue) => (
              <li key={`${issue.code}:${issue.message}`}>{issue.message}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="mt-4 text-xs leading-5 text-tertiary">
        {t("DashboardEarn.queuedWithdraw.solverNotice")}
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
            ? t("DashboardEarn.queuedWithdraw.submitting")
            : t("DashboardEarn.queuedWithdraw.submit")}
        </Button>
      </div>
    </>
  );
}

function QueueDetails({
  amount,
  amountError,
  availableAmount,
  deadline,
  detailsValid,
  discount,
  locale,
  lockedUntil,
  onAmountChange,
  onContinue,
  onDeadlineChange,
  onDiscountChange,
  onMax,
  terms,
}: {
  amount: string;
  amountError: string | null;
  availableAmount: string | undefined;
  deadline: string;
  detailsValid: boolean;
  discount: string;
  locale: string;
  lockedUntil: string | undefined;
  onAmountChange: (value: string) => void;
  onContinue: () => void;
  onDeadlineChange: (value: string) => void;
  onDiscountChange: (value: string) => void;
  onMax: () => void;
  terms: EarnVaultQueuedWithdrawalTerms;
}) {
  const t = useTranslations();
  return (
    <>
      <p className="mt-2 text-sm leading-5 text-secondary">
        {t("DashboardEarn.queuedWithdraw.detailsBody")}
      </p>
      <div className="mt-5 grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="earn-queued-withdraw-amount">
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
            aria-invalid={amountError ? true : undefined}
            id="earn-queued-withdraw-amount"
            inputMode="decimal"
            leadingAddon={<span aria-hidden="true">$</span>}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              onAmountChange(event.target.value);
            }}
            placeholder="0.00"
            value={amount}
          />
          <p className="text-xs text-tertiary">
            {lockedUntil && (!availableAmount || !isPositiveDecimal(availableAmount))
              ? t("DashboardEarn.queuedWithdraw.lockedUntil", { time: lockedUntil })
              : availableAmount
                ? t("DashboardEarn.vaultWithdraw.amountAvailable", {
                    amount: formatUsd(availableAmount, locale),
                  })
                : t("DashboardEarn.vaultWithdraw.amountUnavailable")}
          </p>
          {amountError ? (
            <p className="text-xs text-error" role="alert">
              {amountError}
            </p>
          ) : null}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-2">
            <Label htmlFor="earn-queued-withdraw-discount">
              {t("DashboardEarn.queuedWithdraw.discountBps")}
            </Label>
            <Input
              id="earn-queued-withdraw-discount"
              inputMode="numeric"
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                onDiscountChange(event.target.value);
              }}
              value={discount}
            />
            <p className="text-xs text-tertiary">
              {terms.minimumDiscountBps}–{terms.maximumDiscountBps} bps
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="earn-queued-withdraw-deadline">
              {t("DashboardEarn.queuedWithdraw.deadlineSeconds")}
            </Label>
            <Input
              id="earn-queued-withdraw-deadline"
              inputMode="numeric"
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                onDeadlineChange(event.target.value);
              }}
              value={deadline}
            />
            <p className="text-xs text-tertiary">
              {t("DashboardEarn.queuedWithdraw.deadlineMinimum", {
                seconds: terms.minimumSecondsToDeadline,
              })}
            </p>
          </div>
        </div>
      </div>
      <div className="mt-6">
        <Button className="!w-full" disabled={!detailsValid} onClick={onContinue}>
          {t("DashboardEarn.deposit.continueAction")}
        </Button>
      </div>
    </>
  );
}

export function EarnVaultQueuedWithdrawModal({
  environment,
  onClose,
  onRequested,
  onSettled,
  position,
  projectId,
  terms,
}: QueuedWithdrawalModalProps) {
  const t = useTranslations();
  const locale = useLocale();
  const [step, setStep] = useState<FormStep>("details");
  const [amount, setAmount] = useState("");
  const [discount, setDiscount] = useState(String(terms.minimumDiscountBps));
  const [deadline, setDeadline] = useState(String(terms.minimumSecondsToDeadline));
  const [preview, setPreview] = useState<EarnVaultQueuedWithdrawalPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<EarnVaultQueuedWithdrawalOutcome | null>(null);
  const amountValidation = validateVaultWithdrawalAmount(amount);
  const availableAmount = vaultWithdrawalAvailableAmount(position);
  const shares =
    amountValidation.kind === "valid"
      ? vaultWithdrawalSharesForAmount(amountValidation.canonicalAmount, position)
      : undefined;
  const discountBps = Number(discount);
  const deadlineSeconds = Number(deadline);
  const termsValid =
    Number.isInteger(discountBps) &&
    discountBps >= terms.minimumDiscountBps &&
    discountBps <= terms.maximumDiscountBps &&
    Number.isInteger(deadlineSeconds) &&
    deadlineSeconds >= terms.minimumSecondsToDeadline;
  const detailsValid = shares !== undefined && termsValid;
  const lockedUntil = position.unlockTimestamp
    ? epochDate(position.unlockTimestamp, locale)
    : undefined;
  const previewInput = useMemo(
    () =>
      shares && termsValid
        ? {
            positionId: position.id,
            shares,
            discountBps,
            deadlineSeconds,
          }
        : null,
    [deadlineSeconds, discountBps, position.id, shares, termsValid]
  );

  useEffect(() => {
    if (step !== "review" || !previewInput) return;
    const controller = new AbortController();
    setPreview(null);
    setPreviewLoading(true);
    setError(null);
    void fetchEarnVaultQueuedWithdrawalPreview(previewInput, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.kind === "ready") setPreview(result.value);
        else setError(t("DashboardEarn.queuedWithdraw.previewError"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setPreviewLoading(false);
      });
    return () => controller.abort();
  }, [previewInput, step, t]);

  async function submit() {
    if (!previewInput || submitting || !preview || preview.blockingIssues.length > 0) return;
    setSubmitting(true);
    setError(null);
    const fingerprint = vaultAsyncWithdrawalRequestFingerprint({
      projectId,
      positionId: previewInput.positionId,
      shares: previewInput.shares,
      route: {
        kind: "queue",
        discountBps: previewInput.discountBps,
        deadlineSeconds: previewInput.deadlineSeconds,
      },
    });
    const result = await createEarnVaultWithdrawalRequest(
      previewInput,
      vaultAsyncWithdrawalIdempotencyKeyStore.claim(fingerprint)
    );
    // Bookkeeping must happen before component-local state: the modal may have
    // unmounted while the value-moving POST was in flight. An approval pins
    // this exact intent; ambiguous failures preserve its retry key.
    applyIdempotencyKeyOutcome(vaultAsyncWithdrawalIdempotencyKeyStore, fingerprint, result);
    if (result.ok) {
      setOutcome(result.data);
      if (result.data.kind === "submitted") {
        onRequested?.(result.data.withdrawalRequest);
      }
    } else {
      setError(result.error);
    }
    setSubmitting(false);
  }

  const positionName = position.label || shortenMarketAddress(position.providerReference);
  const modalLabel = t("DashboardEarn.queuedWithdraw.title", { position: positionName });
  const amountError =
    amount.trim() === "" || amountValidation.kind === "valid"
      ? null
      : t("DashboardEarn.vaultWithdraw.amountInvalid");

  return (
    <Modal isOpen ariaLabel={modalLabel} closeDisabled={submitting} onClose={onClose} size="md">
      <div className="p-6">
        <EarnFlowStepper
          currentStep={outcome ? 2 : step === "review" ? 1 : 0}
          steps={[
            t("DashboardEarn.vaultWithdraw.flowDetails"),
            t("DashboardEarn.vaultWithdraw.flowReview"),
            outcome?.kind === "approval_pending"
              ? t("DashboardEarn.queuedWithdraw.flowApproval")
              : t("DashboardEarn.queuedWithdraw.flowRequested"),
          ]}
        />
        <EarnFlowTransition stepKey={outcome ? `result:${outcome.kind}` : step}>
          {outcome?.kind === "approval_pending" ? (
            <QueuedWithdrawalApprovalResult onClose={onClose} outcome={outcome} />
          ) : outcome?.kind === "submitted" ? (
            <QueuedWithdrawalResult
              environment={environment}
              onClose={onClose}
              onSettled={onSettled}
              request={outcome.withdrawalRequest}
            />
          ) : (
            <>
              <h2
                className="pr-8 text-lg font-medium leading-6 text-primary"
                data-modal-focus-target
                tabIndex={-1}
              >
                {modalLabel}
              </h2>
              {step === "details" ? (
                <QueueDetails
                  amount={amount}
                  amountError={amountError}
                  availableAmount={availableAmount}
                  deadline={deadline}
                  detailsValid={detailsValid}
                  discount={discount}
                  locale={locale}
                  lockedUntil={lockedUntil}
                  onAmountChange={setAmount}
                  onContinue={() => setStep("review")}
                  onDeadlineChange={setDeadline}
                  onDiscountChange={setDiscount}
                  onMax={() => {
                    if (availableAmount) setAmount(availableAmount);
                  }}
                  terms={terms}
                />
              ) : (
                <QueueReview
                  error={error}
                  loading={previewLoading}
                  onBack={() => setStep("details")}
                  onSubmit={() => void submit()}
                  position={position}
                  preview={preview}
                  submitting={submitting}
                />
              )}
            </>
          )}
        </EarnFlowTransition>
      </div>
    </Modal>
  );
}
