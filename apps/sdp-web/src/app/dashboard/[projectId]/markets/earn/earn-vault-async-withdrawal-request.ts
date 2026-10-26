"use client";

import type {
  EarnVaultAsyncWithdrawalTermsRequest,
  EarnVaultWithdrawalRequestRecord,
} from "@sdp/types/earn";
import { useEffect, useState } from "react";
import { useSWRConfig } from "swr";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { fetchResultAnswer, uncertainMoneyAnswerMessage } from "@/lib/idempotency";
import { settleIdempotencyKey, settleMoneyIdempotencyKey } from "@/lib/idempotency-key-store";
import {
  cancelEarnVaultWithdrawalRequest,
  createEarnVaultWithdrawalRequest,
  type EarnVaultQueuedWithdrawalOutcome,
  type QueuedReadResult,
} from "./earn-program-data";
import { earnQueryKeys } from "./earn-query-key";
import type { EarnVaultAsyncWithdrawalIntent } from "./earn-vault-async-withdrawal-tracking";
import {
  vaultAsyncWithdrawalIdempotencyKeyStore,
  vaultAsyncWithdrawalRequestFingerprint,
} from "./earn-vault-async-withdrawal-tracking";
import type { VaultSubmissionObserver } from "./earn-vault-movement";

/**
 * The modal machinery shared by the two async-withdrawal request modals
 * (queue and par redemption). Both walk the same details → review flow,
 * preview the same way, submit the same value-moving POST under the same
 * idempotency rules, and land on the same settled-request view with the same
 * recovery cancel. Helpers only — the modals own their markup, because a
 * module that exports both components and helpers breaks Fast Refresh's
 * state preservation (see `earn-vault-slippage.ts`).
 */

/** The two-step form both request modals walk before an outcome. */
type WithdrawalRequestFormStep = "details" | "review";

/**
 * The stepper labels for one async-withdrawal flow: details, review and the
 * request-specific final step.
 */
export function withdrawalRequestSteps(
  t: ReturnType<typeof useTranslations>,
  requestedLabelKey: MessageKey
): string[] {
  return [
    t("DashboardEarn.vaultWithdraw.flowDetails"),
    t("DashboardEarn.vaultWithdraw.flowReview"),
    t(requestedLabelKey),
  ];
}

/** The stepper position for one async-withdrawal flow. */
export function withdrawalRequestStepIndex(
  outcome: EarnVaultQueuedWithdrawalOutcome | null,
  step: WithdrawalRequestFormStep
): number {
  if (outcome) return 2;
  return step === "review" ? 1 : 0;
}

/** The focus key for one async-withdrawal panel, matching the outcome kind. */
export function withdrawalRequestStepKey(
  outcome: EarnVaultQueuedWithdrawalOutcome | null,
  step: WithdrawalRequestFormStep
) {
  return outcome ? `result:${outcome.kind}` : step;
}

/**
 * Owns the review-step preview lifecycle: every change to the request intent
 * refetches a preview while the modal shows the review step, and submit-time
 * errors share this hook's error state so the review view renders one message.
 */
export function useWithdrawalRequestPreview<
  TInput extends EarnVaultAsyncWithdrawalTermsRequest,
  TPreview,
>(options: {
  fetchPreview: (input: TInput, signal: AbortSignal) => Promise<QueuedReadResult<TPreview>>;
  input: TInput | null;
  active: boolean;
  previewErrorMessage: MessageKey;
}) {
  const { active, fetchPreview, input, previewErrorMessage } = options;
  const t = useTranslations();
  const [preview, setPreview] = useState<TPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active || !input) return;
    const controller = new AbortController();
    setPreview(null);
    setLoading(true);
    setError(null);
    void fetchPreview(input, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.kind === "ready") setPreview(result.value);
        else setError(t(previewErrorMessage));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [active, fetchPreview, input, previewErrorMessage, t]);

  return { preview, loading, error, setError };
}

/**
 * Owns the value-moving request submission. Bookkeeping happens before
 * component-local state: the modal may have unmounted while the POST was in
 * flight. Ambiguous failures preserve the retry key. `fingerprintIntent`
 * names the user-controlled fields this modal mints its replay key from.
 */
export function useWithdrawalRequestSubmission<
  TInput extends EarnVaultAsyncWithdrawalTermsRequest,
>(options: {
  onSubmissionStart?: VaultSubmissionObserver;
  custodyWalletId: string;
  onRequested?: (request: EarnVaultWithdrawalRequestRecord) => void;
  projectId: string | null;
  setError: (error: string | null) => void;
  fingerprintIntent: (input: TInput) => EarnVaultAsyncWithdrawalIntent;
}) {
  const t = useTranslations();
  const { mutate } = useSWRConfig();
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<EarnVaultQueuedWithdrawalOutcome | null>(null);

  async function submit(input: TInput | null, preview: { blockingIssues: unknown[] } | null) {
    if (!input || !preview || preview.blockingIssues.length > 0) return;
    setSubmitting(true);
    const finishSubmission = options.onSubmissionStart?.(options.custodyWalletId);
    options.setError(null);
    try {
      const fingerprint = vaultAsyncWithdrawalRequestFingerprint(options.fingerprintIntent(input));
      const { key, persisted } = vaultAsyncWithdrawalIdempotencyKeyStore.claim(fingerprint);
      if (!persisted) {
        options.setError(t("DashboardEarn.intentStorageUnavailable"));
        return;
      }
      const result = await createEarnVaultWithdrawalRequest(input, key);
      // A withdrawal request moves money: an unknown outcome or a reused key
      // keeps the key, so the next press is answered under it.
      const answer = fetchResultAnswer(result);
      settleMoneyIdempotencyKey(vaultAsyncWithdrawalIdempotencyKeyStore, fingerprint, key, answer);
      const uncertain = uncertainMoneyAnswerMessage(answer);
      if (result.ok) {
        setOutcome(result.data);
        options.onRequested?.(result.data.withdrawalRequest);
      } else if (uncertain !== null) {
        options.setError(t(uncertain));
        void mutate(earnQueryKeys.vaultWithdrawalRequestsOpen());
      } else {
        options.setError(result.error);
      }
    } finally {
      finishSubmission?.();
      setSubmitting(false);
    }
  }

  return { submitting, outcome, submit };
}

/**
 * The record the settled view renders: a local cancel result wins only while
 * it is at least as fresh as the last server-observed record. Compare
 * freshness as instants, not raw strings: the record schema only types
 * `updatedAt` as a string, so mixed fractional-seconds formatting could order
 * two ISO strings lexicographically against their true order and let a stale
 * poll override a just-confirmed cancel. An unparseable timestamp makes the
 * comparison false, so the server-observed record wins.
 */
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

/**
 * Owns the settled-request view model: local cancellation state wins only
 * until server polling reports a record at least as fresh, and the recovery
 * cancel action reuses one idempotency key per ambiguous transport attempt.
 * `cancelable` decides which requests still admit that recovery action.
 */
export function useWithdrawalRequestView(options: {
  cancelable: (request: EarnVaultWithdrawalRequestRecord) => boolean;
  observed: EarnVaultWithdrawalRequestRecord | undefined;
  submitted: EarnVaultWithdrawalRequestRecord;
}) {
  const [cancelResult, setCancelResult] = useState<EarnVaultWithdrawalRequestRecord | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const t = useTranslations();
  const request = freshCancelRecord(cancelResult, options.observed, options.submitted);
  const cancelable = options.cancelable(request);

  async function cancel() {
    if (!cancelable || cancelling) return;
    setCancelling(true);
    setCancelError(null);
    const fingerprint = `cancel:${request.withdrawalRequestId}`;
    try {
      const { key, persisted } = vaultAsyncWithdrawalIdempotencyKeyStore.claim(fingerprint);
      if (!persisted) {
        setCancelError(t("DashboardEarn.intentStorageUnavailable"));
        return;
      }
      const result = await cancelEarnVaultWithdrawalRequest(request.withdrawalRequestId, key);
      if (result.ok) {
        vaultAsyncWithdrawalIdempotencyKeyStore.release(fingerprint, key);
        setCancelResult(result.data);
      } else {
        settleIdempotencyKey(
          vaultAsyncWithdrawalIdempotencyKeyStore,
          fingerprint,
          key,
          fetchResultAnswer(result)
        );
        setCancelError(result.error);
      }
    } finally {
      setCancelling(false);
    }
  }

  return { cancel, cancelError, cancelable, cancelling, request };
}
