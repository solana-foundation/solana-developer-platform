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
} from "./earn-program-data";
import { earnQueryKeys } from "./earn-query-key";
import {
  type EarnVaultAsyncWithdrawalIntent,
  vaultAsyncWithdrawalIdempotencyKeyStore,
  vaultAsyncWithdrawalRequestFingerprint,
} from "./earn-vault-async-withdrawal-tracking";
import type { VaultSubmissionObserver } from "./earn-vault-movement";

/**
 * The request lifecycle shared by the two async-exit modals — the solver queue
 * (`earn-vault-queued-withdraw-modal`) and the operator par redemption
 * (`earn-vault-par-redemption-modal`): the review-step preview poll, the
 * value-moving submission under one idempotency key, and the settled-request
 * view model with its recovery cancel. Each modal keeps its own presentation,
 * its own steps copy and its own fingerprint recipe; this module owns only the
 * plumbing both must run identically. One copy on purpose — two copies of a
 * money-key lifecycle is how one drifts, the same reasoning as the slippage
 * machinery in `earn-vault-slippage.ts`.
 */

/** The two pre-result steps both async-exit modals walk before the outcome. */
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
) {
  return outcome ? `result:${outcome.kind}` : step;
}

/**
 * Which settled-request record to render: the local cancellation result wins
 * only until server polling reports a record at least as fresh. Compare
 * freshness as instants, not raw strings: the record schema only types
 * `updatedAt` as a string, so mixed fractional-seconds formatting could order
 * two ISO strings lexicographically against their true order and let a stale
 * poll override a just-confirmed cancel. An unparseable timestamp makes the
 * comparison false, so the server-observed record wins.
 */
export function freshWithdrawalRequestRecord(
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

/** A preview read over the BFF proxies — the shape the `fetchEarn*Preview` readers answer. */
type PreviewRead<TPreview> = { kind: "ready"; value: TPreview } | { kind: "unavailable" };

/**
 * Owns the review-step preview lifecycle: every change to the withdrawal
 * intent refetches a preview while the modal shows the review step, and
 * submit-time errors share this hook's error state so the review view renders
 * one message.
 */
export function useVaultAsyncWithdrawalPreview<TRequest, TPreview>(options: {
  active: boolean;
  fetchPreview: (input: TRequest, signal: AbortSignal) => Promise<PreviewRead<TPreview>>;
  input: TRequest | null;
  previewErrorMessageKey: MessageKey;
}) {
  const { active, fetchPreview, input, previewErrorMessageKey } = options;
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
        else setError(t(previewErrorMessageKey));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [active, fetchPreview, input, previewErrorMessageKey, t]);

  return { preview, loading, error, setError };
}

/**
 * Owns the value-moving request submission. Bookkeeping happens before
 * component-local state: the modal may have unmounted while the POST was in
 * flight. Ambiguous failures preserve the retry key. `buildIntent` names the
 * idempotency fingerprint — the route mechanism plus every user-controlled
 * field of the request, per the tracking module's recipe.
 */
export function useVaultAsyncWithdrawalSubmission<
  TRequest extends EarnVaultAsyncWithdrawalTermsRequest,
>(options: {
  buildIntent: (input: TRequest, projectId: string | null) => EarnVaultAsyncWithdrawalIntent;
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

  async function submit(
    input: TRequest | null,
    preview: { blockingIssues: Array<{ code: string; message: string }> } | null
  ) {
    if (!input || !preview || preview.blockingIssues.length > 0) return;
    setSubmitting(true);
    const finishSubmission = options.onSubmissionStart?.(options.custodyWalletId);
    options.setError(null);
    try {
      const fingerprint = vaultAsyncWithdrawalRequestFingerprint(
        options.buildIntent(input, options.projectId)
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
 * Owns the settled-request view model: local cancellation state wins only
 * until server polling reports a record at least as fresh, and the recovery
 * cancel action reuses one idempotency key per ambiguous transport attempt.
 * `isCancelable` is the mechanism's own rule for when the cancel action may
 * run — the queue's cancellable window, the par redemption's terms.
 */
export function useVaultAsyncWithdrawalRequestView(options: {
  isCancelable: (request: EarnVaultWithdrawalRequestRecord) => boolean;
  observed: EarnVaultWithdrawalRequestRecord | undefined;
  submitted: EarnVaultWithdrawalRequestRecord;
}) {
  const [cancelResult, setCancelResult] = useState<EarnVaultWithdrawalRequestRecord | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const t = useTranslations();
  const request = freshWithdrawalRequestRecord(cancelResult, options.observed, options.submitted);
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
