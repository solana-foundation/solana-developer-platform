"use client";

import type {
  EarnVaultAsyncWithdrawalTermsRequest,
  EarnVaultQueuedWithdrawalPreview,
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
import { vaultAsyncWithdrawalIdempotencyKeyStore } from "./earn-vault-async-withdrawal-tracking";
import type { VaultSubmissionObserver } from "./earn-vault-movement";

/**
 * The form machinery both async-withdrawal modals walk — the solver queue and
 * the operator par redemption differ only in the input they preview and the
 * fingerprint their request hashes to, so the shared lifecycle lives here
 * once: the details→review steps, the review-step preview, the value-moving
 * submission, and the settled-request view with its recovery cancel.
 * Per-flow copy stays with each modal.
 */

/** The form steps before an outcome renders. */
export type EarnVaultAsyncWithdrawalStep = "details" | "review";

/** The three-step flow: details, review, then the settled-request result. */
export function earnVaultAsyncWithdrawalSteps(
  t: ReturnType<typeof useTranslations>,
  requestedKey: MessageKey
): string[] {
  return [
    t("DashboardEarn.vaultWithdraw.flowDetails"),
    t("DashboardEarn.vaultWithdraw.flowReview"),
    t(requestedKey),
  ];
}

export function earnVaultAsyncWithdrawalStepIndex(
  outcome: EarnVaultQueuedWithdrawalOutcome | null,
  step: EarnVaultAsyncWithdrawalStep
): number {
  if (outcome) return 2;
  return step === "review" ? 1 : 0;
}

export function earnVaultAsyncWithdrawalStepKey(
  outcome: EarnVaultQueuedWithdrawalOutcome | null,
  step: EarnVaultAsyncWithdrawalStep
): string {
  return outcome ? `result:${outcome.kind}` : step;
}

/**
 * The settled-request view's record: a local cancellation wins only until
 * server polling reports a record at least as fresh. Compare freshness as
 * instants, not raw strings: the record schema only types `updatedAt` as a
 * string, so mixed fractional-seconds formatting could order two ISO strings
 * lexicographically against their true order and let a stale poll override a
 * just-confirmed cancel. An unparseable timestamp makes the comparison false,
 * so the server-observed record wins.
 */
export function freshCancelRecord(
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
 * Owns the review-step preview lifecycle: every change to the queue intent
 * refetches a preview while the modal shows the review step, and submit-time
 * errors share this hook's error state so the review view renders one message.
 * The fetcher and its failure copy are each flow's own.
 */
export function useEarnVaultAsyncWithdrawalPreview<Input, Preview>(options: {
  active: boolean;
  fetchPreview: (input: Input, signal: AbortSignal) => Promise<QueuedReadResult<Preview>>;
  input: Input | null;
  previewErrorMessage: MessageKey;
}) {
  const t = useTranslations();
  const { active, fetchPreview, input, previewErrorMessage } = options;
  const [preview, setPreview] = useState<Preview | null>(null);
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

  return { error, loading, preview, setError };
}

/**
 * Owns the value-moving request submission. Bookkeeping happens before
 * component-local state: the modal may have unmounted while the POST was in
 * flight. Ambiguous failures preserve the retry key. Each flow hashes only its
 * own fingerprint, from the same withdrawal-request input the POST carries.
 */
export function useEarnVaultAsyncWithdrawalSubmission<
  Input extends EarnVaultAsyncWithdrawalTermsRequest,
>(options: {
  custodyWalletId: string;
  fingerprint: (input: Input) => string;
  onRequested?: (request: EarnVaultWithdrawalRequestRecord) => void;
  onSubmissionStart?: VaultSubmissionObserver;
  projectId: string | null;
  setError: (error: string | null) => void;
}) {
  const t = useTranslations();
  const { mutate } = useSWRConfig();
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<EarnVaultQueuedWithdrawalOutcome | null>(null);

  async function submit(
    input: Input | null,
    preview: Pick<EarnVaultQueuedWithdrawalPreview, "blockingIssues"> | null
  ) {
    if (!input || !preview || preview.blockingIssues.length > 0) return;
    setSubmitting(true);
    const finishSubmission = options.onSubmissionStart?.(options.custodyWalletId);
    options.setError(null);
    try {
      const fingerprint = options.fingerprint(input);
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
 * Owns the settled-request view model: local cancellation state wins only
 * until server polling reports a record at least as fresh, and the recovery
 * cancel action reuses one idempotency key per ambiguous transport attempt.
 * Whether a settled request may still be cancelled is each flow's own rule.
 */
export function useEarnVaultAsyncWithdrawalRequestView(
  submitted: EarnVaultWithdrawalRequestRecord,
  observed: EarnVaultWithdrawalRequestRecord | undefined,
  isCancelable: (request: EarnVaultWithdrawalRequestRecord) => boolean,
  cancelAllowed = true
) {
  const [cancelResult, setCancelResult] = useState<EarnVaultWithdrawalRequestRecord | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const t = useTranslations();
  const request = freshCancelRecord(cancelResult, observed, submitted);
  const cancelable = cancelAllowed && isCancelable(request);

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
