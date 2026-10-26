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
import type { QueuedReadResult } from "./earn-program-data";
import {
  cancelEarnVaultWithdrawalRequest,
  createEarnVaultWithdrawalRequest,
  type EarnVaultQueuedWithdrawalOutcome,
} from "./earn-program-data";
import { earnQueryKeys } from "./earn-query-key";
import {
  type EarnVaultAsyncWithdrawalIntent,
  vaultAsyncWithdrawalIdempotencyKeyStore,
  vaultAsyncWithdrawalRequestFingerprint,
} from "./earn-vault-async-withdrawal-tracking";
import type { VaultSubmissionObserver } from "./earn-vault-movement";

/**
 * The modal lifecycle hooks BOTH asynchronous vault-exit modals share — the
 * queued (solver) modal and the par-redemption modal are the same three-stage
 * flow over different request types: a live preview while the review step is
 * shown, one value-moving request submission under an idempotency key, and a
 * settled-request view whose recovery cancel reuses one key per ambiguous
 * attempt. One copy on purpose, the same reasoning as the slippage machinery:
 * two copies of a money-key lifecycle is how one drifts.
 */

/** The two form steps before the submitted-request receipt replaces the form. */
export type VaultAsyncWithdrawalFormStep = "details" | "review";

export function vaultAsyncWithdrawalStepIndex(
  outcome: EarnVaultQueuedWithdrawalOutcome | null,
  step: VaultAsyncWithdrawalFormStep
): number {
  if (outcome) return 2;
  return step === "review" ? 1 : 0;
}

export function vaultAsyncWithdrawalStepKey(
  outcome: EarnVaultQueuedWithdrawalOutcome | null,
  step: VaultAsyncWithdrawalFormStep
): string {
  return outcome ? `result:${outcome.kind}` : step;
}

/**
 * Owns the review-step preview lifecycle: every change to the withdrawal
 * intent refetches a preview while the modal shows the review step, and
 * submit-time errors share this hook's error state so the review view renders
 * one message.
 */
export function useVaultAsyncWithdrawalPreview<TRequest, TPreview>(
  input: TRequest | null,
  active: boolean,
  fetchPreview: (input: TRequest, signal?: AbortSignal) => Promise<QueuedReadResult<TPreview>>,
  previewErrorKey: MessageKey
) {
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
        else setError(t(previewErrorKey));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [active, input, fetchPreview, previewErrorKey, t]);

  return { preview, loading, error, setError };
}

/**
 * Owns the value-moving request submission. Bookkeeping happens before
 * component-local state: the modal may have unmounted while the POST was in
 * flight. Ambiguous failures preserve the retry key.
 *
 * `intent` derives the modal's own fingerprint fields — the route mechanism
 * and the amount that make one retry distinct from a new intent.
 */
export function useVaultAsyncWithdrawalSubmission<
  TRequest extends EarnVaultAsyncWithdrawalTermsRequest,
>(options: {
  intent: (request: TRequest, projectId: string | null) => EarnVaultAsyncWithdrawalIntent;
  custodyWalletId: string;
  onRequested?: (request: EarnVaultWithdrawalRequestRecord) => void;
  onSubmissionStart?: VaultSubmissionObserver;
  projectId: string | null;
  setError: (error: string | null) => void;
}) {
  const t = useTranslations();
  const { mutate } = useSWRConfig();
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<EarnVaultQueuedWithdrawalOutcome | null>(null);

  async function submit(request: TRequest | null, preview: { blockingIssues: unknown[] } | null) {
    if (!request || !preview || preview.blockingIssues.length > 0) return;
    setSubmitting(true);
    const finishSubmission = options.onSubmissionStart?.(options.custodyWalletId);
    options.setError(null);
    try {
      const fingerprint = vaultAsyncWithdrawalRequestFingerprint(
        options.intent(request, options.projectId)
      );
      const { key, persisted } = vaultAsyncWithdrawalIdempotencyKeyStore.claim(fingerprint);
      if (!persisted) {
        options.setError(t("DashboardEarn.intentStorageUnavailable"));
        return;
      }
      const result = await createEarnVaultWithdrawalRequest(request, key);
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
 */
export function useVaultAsyncWithdrawalRequestView(options: {
  submitted: EarnVaultWithdrawalRequestRecord;
  observed: EarnVaultWithdrawalRequestRecord | undefined;
  /** Whether the freshest record still admits the recovery cancel action. */
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

  return { cancel, cancelable, cancelError, cancelling, request };
}
