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

/** A preview's blocking issue, as both preview responses carry them. */
type PreviewIssue = { code: string; message: string };

/**
 * The three-step flow both async-withdrawal modals spell: details, review,
 * then the request-specific "requested" step whose label names the route
 * (queued escrow vs par redemption).
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

export function withdrawalRequestStepIndex(
  outcome: EarnVaultQueuedWithdrawalOutcome | null,
  step: "details" | "review"
): number {
  if (outcome) return 2;
  return step === "review" ? 1 : 0;
}

export function withdrawalRequestStepKey(
  outcome: EarnVaultQueuedWithdrawalOutcome | null,
  step: "details" | "review"
): string {
  return outcome ? `result:${outcome.kind}` : step;
}

/**
 * Owns the review-step preview lifecycle, shared by both async-withdrawal
 * modals: every change to the request intent refetches a preview while the
 * modal shows the review step, and submit-time errors share this hook's error
 * state so the review view renders one message.
 */
export function useWithdrawalRequestPreview<Input, Preview>(
  input: Input | null,
  active: boolean,
  fetchPreview: (
    input: Input,
    signal: AbortSignal
  ) => Promise<{ kind: "ready"; value: Preview } | { kind: "unavailable" }>,
  previewErrorKey: MessageKey
) {
  const t = useTranslations();
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
        else setError(t(previewErrorKey));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [active, fetchPreview, input, previewErrorKey, t]);

  return { preview, loading, error, setError };
}

/**
 * Owns the value-moving request submission shared by both async-withdrawal
 * modals (queued escrow and par redemption). The two differ only in the
 * fingerprint their route mints — the `fingerprint` option builds each
 * route's intent, and the claim / settle / report rules live here once.
 * Bookkeeping happens before component-local state: the modal may have
 * unmounted while the POST was in flight. Ambiguous failures preserve the
 * retry key.
 */
export function useWithdrawalRequestSubmission<
  Input extends EarnVaultAsyncWithdrawalTermsRequest,
>(options: {
  fingerprint: (input: Input) => EarnVaultAsyncWithdrawalIntent;
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
    input: Input | null,
    preview: { blockingIssues: ReadonlyArray<PreviewIssue> } | null
  ) {
    if (!input || !preview || preview.blockingIssues.length > 0) return;
    setSubmitting(true);
    const finishSubmission = options.onSubmissionStart?.(options.custodyWalletId);
    options.setError(null);
    try {
      const fingerprint = vaultAsyncWithdrawalRequestFingerprint(options.fingerprint(input));
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
 * `isCancelable` is each route's own rule for which request records still
 * expose a cancel (the queued lifecycle's expiry window vs the par terms'
 * provider switch).
 */
export function useWithdrawalRequestCancel(
  submitted: EarnVaultWithdrawalRequestRecord,
  observed: EarnVaultWithdrawalRequestRecord | undefined,
  isCancelable: (request: EarnVaultWithdrawalRequestRecord) => boolean
) {
  const [cancelResult, setCancelResult] = useState<EarnVaultWithdrawalRequestRecord | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const t = useTranslations();
  // Compare freshness as instants, not raw strings: the record schema only
  // types `updatedAt` as a string, so mixed fractional-seconds formatting
  // could order two ISO strings lexicographically against their true order
  // and let a stale poll override a just-confirmed cancel. An unparseable
  // timestamp makes the comparison false, so the server-observed record wins.
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

/** The warning list both review steps render when a preview cannot support a submit. */
export function PreviewBlockingIssues({
  headingKey,
  issues,
}: {
  headingKey: MessageKey;
  issues: ReadonlyArray<PreviewIssue>;
}) {
  const t = useTranslations();
  return (
    <div
      className="mt-4 rounded-lg border border-warning-border bg-warning-bg p-3 text-sm text-warning"
      role="alert"
    >
      <p>{t(headingKey)}</p>
      <ul className="mt-1 list-disc space-y-1 pl-5">
        {issues.map((issue) => (
          <li key={`${issue.code}:${issue.message}`}>{issue.message}</li>
        ))}
      </ul>
    </div>
  );
}
