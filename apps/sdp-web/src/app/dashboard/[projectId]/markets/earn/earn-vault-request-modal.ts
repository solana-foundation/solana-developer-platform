"use client";

import type {
  EarnVaultAsyncWithdrawalTermsRequest,
  EarnVaultWithdrawalRequestRecord,
} from "@sdp/types/earn";
import { useEffect, useRef, useState } from "react";
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
 * The request lifecycle shared by the two asynchronous withdrawal-request
 * modals (the solver queue and the operator par redemption): a live preview
 * refetched on every intent change, one value-moving submission under an
 * idempotency key derived from the request's fingerprint, and the settled
 * request's recovery view with its own cancel key. The two modals POST the
 * same endpoint and settle the same record, so the money-safety bookkeeping —
 * claim before the POST, settle on the answer, release only an acknowledged
 * cancel — is spelled here once. Helpers only: the modals' review-step
 * widgets live beside the modals, because a module that exports both
 * components and helpers breaks Fast Refresh's state preservation.
 */

/** The form half of either request flow, before a submitted outcome replaces it. */
export type VaultRequestFormStep = "details" | "review";

/** The stepper labels for one request flow: details, review, then the request state. */
export function vaultRequestFlowSteps(
  t: ReturnType<typeof useTranslations>,
  requestedLabelKey: MessageKey
): string[] {
  return [
    t("DashboardEarn.vaultWithdraw.flowDetails"),
    t("DashboardEarn.vaultWithdraw.flowReview"),
    t(requestedLabelKey),
  ];
}

export function vaultRequestStepIndex(
  outcome: EarnVaultQueuedWithdrawalOutcome | null,
  step: VaultRequestFormStep
): number {
  if (outcome) return 2;
  return step === "review" ? 1 : 0;
}

export function vaultRequestStepKey(
  outcome: EarnVaultQueuedWithdrawalOutcome | null,
  step: VaultRequestFormStep
) {
  return outcome ? `result:${outcome.kind}` : step;
}

/**
 * Owns the review-step preview lifecycle: every change to the request intent
 * refetches a preview while the modal shows the review step, and submit-time
 * errors share this hook's error state so the review view renders one message.
 */
export function useVaultRequestPreview<
  TInput extends EarnVaultAsyncWithdrawalTermsRequest,
  TPreview,
>(options: {
  fetchPreview: (input: TInput, signal: AbortSignal) => Promise<QueuedReadResult<TPreview>>;
  input: TInput | null;
  active: boolean;
  previewErrorKey: MessageKey;
}) {
  const t = useTranslations();
  const [preview, setPreview] = useState<TPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The fetcher is read through a ref so a re-render never re-fires the
  // request — the effect re-runs on the request intent alone.
  const fetchPreviewRef = useRef(options.fetchPreview);
  useEffect(() => {
    fetchPreviewRef.current = options.fetchPreview;
  });

  const { input, active, previewErrorKey } = options;
  useEffect(() => {
    if (!active || !input) return;
    const controller = new AbortController();
    setPreview(null);
    setPreviewLoading(true);
    setError(null);
    void fetchPreviewRef
      .current(input, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.kind === "ready") setPreview(result.value);
        else setError(t(previewErrorKey));
      })
      .finally(() => {
        if (!controller.signal.aborted) setPreviewLoading(false);
      });
    return () => controller.abort();
  }, [input, active, previewErrorKey, t]);

  return { preview, previewLoading, error, setError };
}

/**
 * Owns the value-moving request submission. Bookkeeping happens before
 * component-local state: the modal may have unmounted while the POST was in
 * flight. Ambiguous failures preserve the retry key. `requestFingerprint`
 * maps the route-specific input to the intent fields the key is derived from,
 * so every user-controlled field is in the fingerprint and an edited request
 * mints a fresh key.
 */
export function useVaultRequestSubmission<
  TInput extends EarnVaultAsyncWithdrawalTermsRequest,
>(options: {
  onSubmissionStart?: VaultSubmissionObserver;
  custodyWalletId: string;
  onRequested?: (request: EarnVaultWithdrawalRequestRecord) => void;
  projectId: string | null;
  setError: (error: string | null) => void;
  requestFingerprint: (input: TInput) => string;
}) {
  const t = useTranslations();
  const { mutate } = useSWRConfig();
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<EarnVaultQueuedWithdrawalOutcome | null>(null);

  async function submit(
    input: TInput | null,
    preview: { blockingIssues: readonly unknown[] } | null
  ) {
    if (!input || !preview || preview.blockingIssues.length > 0) return;
    setSubmitting(true);
    const finishSubmission = options.onSubmissionStart?.(options.custodyWalletId);
    options.setError(null);
    try {
      const fingerprint = options.requestFingerprint(input);
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
 * The local cancellation state wins only until server polling reports a record
 * at least as fresh, and the recovery cancel action reuses one idempotency key
 * per ambiguous transport attempt.
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
 * Owns the settled-request view model: which record to show (see
 * `freshCancelRecord`) and whether the recovery cancel action is offered.
 * `isCancelable` is each flow's own cancel rule, read off the record the
 * modal is currently showing.
 */
export function useVaultRequestCancelView(options: {
  submitted: EarnVaultWithdrawalRequestRecord;
  observed: EarnVaultWithdrawalRequestRecord | undefined;
  isCancelable: (request: EarnVaultWithdrawalRequestRecord) => boolean;
}) {
  const [cancelResult, setCancelResult] = useState<EarnVaultWithdrawalRequestRecord | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const t = useTranslations();
  // Compare freshness as instants, not raw strings: the record schema only
  // types `updatedAt` as a string, so mixed fractional-seconds formatting
  // could order two ISO strings lexicographically against their true order
  // and let a stale poll override a just-confirmed cancel. An unparseable
  // timestamp makes the comparison false, so the server-observed record wins.
  const request = freshCancelRecord(cancelResult, options.observed, options.submitted);
  const cancelable = options.isCancelable(request);

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
