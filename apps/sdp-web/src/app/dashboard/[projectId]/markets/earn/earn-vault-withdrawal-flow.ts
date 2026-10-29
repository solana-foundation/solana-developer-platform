"use client";

/**
 * The flow machinery the queued-withdraw and par-redemption modals share:
 * both turn a position into a withdrawal request through the same three steps
 * (details → review → requested), the same preview refetch lifecycle, the same
 * idempotency-keyed submission and the same settled-request view with its
 * recovery cancel. Only the preview fetcher, the fingerprint's route fields
 * and the cancelable predicate differ — those are the parameters, everything
 * else is written once so the two modals cannot drift.
 */

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
import {
  type EarnVaultAsyncWithdrawalIntent,
  vaultAsyncWithdrawalIdempotencyKeyStore,
  vaultAsyncWithdrawalRequestFingerprint,
} from "./earn-vault-async-withdrawal-tracking";
import type { VaultSubmissionObserver } from "./earn-vault-movement";

/** The two steps a modal shows before the request exists. */
export type WithdrawalFlowStep = "details" | "review";

/** The three stepper labels; only what the third step is called differs per flow. */
export function withdrawalFlowSteps(
  t: ReturnType<typeof useTranslations>,
  requestedLabelKey: MessageKey
): string[] {
  return [
    t("DashboardEarn.vaultWithdraw.flowDetails"),
    t("DashboardEarn.vaultWithdraw.flowReview"),
    t(requestedLabelKey),
  ];
}

export function withdrawalFlowStepIndex(
  outcome: EarnVaultQueuedWithdrawalOutcome | null,
  step: WithdrawalFlowStep
): number {
  if (outcome) return 2;
  return step === "review" ? 1 : 0;
}

export function withdrawalFlowStepKey(
  outcome: EarnVaultQueuedWithdrawalOutcome | null,
  step: WithdrawalFlowStep
) {
  return outcome ? `result:${outcome.kind}` : step;
}

/**
 * Owns the review-step preview lifecycle: every change to the intent refetches
 * a preview while the modal shows the review step, and submit-time errors
 * share this hook's error state so the review view renders one message.
 */
export function useEarnVaultWithdrawalPreview<TInput, TPreview>(
  fetchPreview: (input: TInput, signal: AbortSignal) => Promise<QueuedReadResult<TPreview>>,
  input: TInput | null,
  active: boolean,
  previewErrorKey: MessageKey
) {
  const t = useTranslations();
  const [preview, setPreview] = useState<TPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active || !input) return;
    const controller = new AbortController();
    setPreview(null);
    setPreviewLoading(true);
    setError(null);
    void fetchPreview(input, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.kind === "ready") setPreview(result.value);
        else setError(t(previewErrorKey));
      })
      .finally(() => {
        if (!controller.signal.aborted) setPreviewLoading(false);
      });
    return () => controller.abort();
    // The fetcher and the error key are module-stable at every call site; the
    // effect reruns on the intent and on the step, as in each modal before.
  }, [active, fetchPreview, input, previewErrorKey, t]);

  return { preview, previewLoading, error, setError };
}

/**
 * Owns the value-moving request submission. Bookkeeping happens before
 * component-local state: the modal may have unmounted while the POST was in
 * flight. Ambiguous failures preserve the retry key. `fingerprintFor` names
 * the route fields that make one flow's key distinct from the other's.
 */
export function useEarnVaultWithdrawalSubmission<
  TInput extends EarnVaultAsyncWithdrawalTermsRequest,
  TPreview extends { blockingIssues: Array<{ code: string; message: string }> },
>(options: {
  custodyWalletId: string;
  fingerprintFor: (input: TInput, projectId: string | null) => EarnVaultAsyncWithdrawalIntent;
  onRequested?: (request: EarnVaultWithdrawalRequestRecord) => void;
  onSubmissionStart?: VaultSubmissionObserver;
  projectId: string | null;
  setError: (error: string | null) => void;
}) {
  const t = useTranslations();
  const { mutate } = useSWRConfig();
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<EarnVaultQueuedWithdrawalOutcome | null>(null);

  async function submit(input: TInput | null, preview: TPreview | null) {
    if (!input || !preview || preview.blockingIssues.length > 0) return;
    setSubmitting(true);
    const finishSubmission = options.onSubmissionStart?.(options.custodyWalletId);
    options.setError(null);
    try {
      const fingerprint = vaultAsyncWithdrawalRequestFingerprint(
        options.fingerprintFor(input, options.projectId)
      );
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
 * The record a settled-request view shows: local cancellation state wins only
 * until server polling reports a record at least as fresh.
 *
 * Compare freshness as instants, not raw strings: the record schema only types
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
 * Owns the settled-request view model, including the recovery cancel action:
 * one idempotency key per ambiguous transport attempt, released when the
 * cancel is answered. `isCancelable` is each flow's own predicate on the
 * record — the queued flow cancels an expired-and-cancelable request, the
 * par redemption asks its terms.
 */
export function useEarnVaultWithdrawalRequestView({
  isCancelable,
  observed,
  submitted,
}: {
  isCancelable: (request: EarnVaultWithdrawalRequestRecord) => boolean;
  observed: EarnVaultWithdrawalRequestRecord | undefined;
  submitted: EarnVaultWithdrawalRequestRecord;
}) {
  const [cancelResult, setCancelResult] = useState<EarnVaultWithdrawalRequestRecord | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const t = useTranslations();
  const request = freshCancelRecord(cancelResult, observed, submitted);
  const cancelable = isCancelable(request);

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
