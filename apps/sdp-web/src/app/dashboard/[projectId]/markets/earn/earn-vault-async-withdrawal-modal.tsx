"use client";

/**
 * The flow both asynchronous vault exit modals run: a review step whose
 * preview refetches on every intent change, one idempotent money-moving
 * submission, and a settled-request view whose local cancellation wins only
 * until server polling reports something at least as fresh. The queue modal
 * (`earn-vault-queued-withdraw-modal`) and the par-redemption modal
 * (`earn-vault-par-redemption-modal`) run these stages over different preview
 * and input types, so the orchestration — and the money-safety comments it
 * carries — exists exactly once, here. Route specifics (the fetcher, the
 * fingerprint, what makes a request cancelable) stay with each modal.
 */

import type {
  EarnVaultAsyncWithdrawalTermsRequest,
  EarnVaultWithdrawalRequestRecord,
} from "@sdp/types/earn";
import { Button } from "@sdp/ui/button";
import { Callout } from "@sdp/ui/callout";
import { Loader2Icon } from "lucide-react";
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
import { vaultAsyncWithdrawalIdempotencyKeyStore } from "./earn-vault-async-withdrawal-tracking";
import type { VaultSubmissionObserver } from "./earn-vault-movement";

/** How a preview read lands: a parsed preview, or an unreadable answer. */
type AsyncPreviewRead<Preview> = { kind: "ready"; value: Preview } | { kind: "unavailable" };

/** What stands between the reviewed intent and its submission, named by the preview. */
interface PreviewIssue {
  code: string;
  message: string;
}

/** The details → review → requested steps, as the stepper renders them. */
export function asyncWithdrawalSteps(
  t: ReturnType<typeof useTranslations>,
  requestedKey: MessageKey
): string[] {
  return [
    t("DashboardEarn.vaultWithdraw.flowDetails"),
    t("DashboardEarn.vaultWithdraw.flowReview"),
    t(requestedKey),
  ];
}

export function asyncWithdrawalStepIndex(
  outcome: EarnVaultQueuedWithdrawalOutcome | null,
  step: "details" | "review"
): number {
  if (outcome) return 2;
  return step === "review" ? 1 : 0;
}

export function asyncWithdrawalStepKey(
  outcome: EarnVaultQueuedWithdrawalOutcome | null,
  step: "details" | "review"
) {
  return outcome ? `result:${outcome.kind}` : step;
}

/**
 * Whose withdrawal-request record to show: a local cancel wins only until a
 * poll reports a record at least as fresh. Freshness compares instants, not
 * raw strings: the record schema only types `updatedAt` as a string, so mixed
 * fractional-seconds formatting could order two ISO strings lexicographically
 * against their true order and let a stale poll override a just-confirmed
 * cancel. An unparseable timestamp makes the comparison false, so the
 * server-observed record wins.
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

/** The review step's spinner while a changed intent refetches its preview. */
export function AsyncWithdrawalPreviewLoading({ messageKey }: { messageKey: MessageKey }) {
  const t = useTranslations();
  return (
    <div className="mt-5 flex items-center gap-2 text-body text-secondary" role="status">
      <Loader2Icon aria-hidden="true" className="size-4 animate-spin" />
      {t(messageKey)}
    </div>
  );
}

/** The preview's blocking issues, which hold the submit button until answered. */
export function AsyncWithdrawalPreviewIssues({
  issues,
  titleKey,
}: {
  issues: readonly PreviewIssue[];
  titleKey: MessageKey;
}) {
  const t = useTranslations();
  return (
    <Callout className="mt-4" live title={t(titleKey)} variant="warning">
      <ul className="list-disc space-y-1 pl-5">
        {issues.map((issue) => (
          <li key={`${issue.code}:${issue.message}`}>{issue.message}</li>
        ))}
      </ul>
    </Callout>
  );
}

/** The review footer: back to the details, then the one money-moving button. */
export function AsyncWithdrawalReviewActions({
  loading,
  onBack,
  onSubmit,
  preview,
  submitKey,
  submittingKey,
  submitting,
}: {
  loading: boolean;
  onBack: () => void;
  onSubmit: () => void;
  preview: { blockingIssues: readonly PreviewIssue[] } | null;
  submitKey: MessageKey;
  submittingKey: MessageKey;
  submitting: boolean;
}) {
  const t = useTranslations();
  return (
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
        {submitting ? t(submittingKey) : t(submitKey)}
      </Button>
    </div>
  );
}

/**
 * Owns the review-step preview lifecycle: every change to the exit intent
 * refetches a preview while the modal shows the review step, and submit-time
 * errors share this hook's error state so the review view renders one message.
 * `fetchPreview` must be a stable module function — it joins the effect deps.
 */
export function useAsyncWithdrawalPreview<Input, Preview>(
  fetchPreview: (input: Input, signal: AbortSignal) => Promise<AsyncPreviewRead<Preview>>,
  input: Input | null,
  active: boolean,
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
 * Owns the value-moving request submission. Bookkeeping happens before
 * component-local state: the modal may have unmounted while the POST was in
 * flight. Ambiguous failures preserve the retry key.
 */
export function useAsyncWithdrawalSubmission<
  Input extends EarnVaultAsyncWithdrawalTermsRequest,
>(options: {
  /** The route's fingerprint: every user-controlled field, so a changed intent never reuses a key. */
  fingerprint: (input: Input) => string;
  onSubmissionStart?: VaultSubmissionObserver;
  custodyWalletId: string;
  onRequested?: (request: EarnVaultWithdrawalRequestRecord) => void;
  projectId: string | null;
  setError: (error: string | null) => void;
}) {
  const t = useTranslations();
  const { mutate } = useSWRConfig();
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<EarnVaultQueuedWithdrawalOutcome | null>(null);

  async function submit(
    input: Input | null,
    preview: { blockingIssues: readonly PreviewIssue[] } | null
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
 * until server polling reports a record at least as fresh (via
 * `freshCancelRecord`), and the recovery cancel action reuses one idempotency
 * key per ambiguous transport attempt. `canCancel` is the route's rule for
 * whether the shown record can still be cancelled.
 */
export function useAsyncWithdrawalRequestView(options: {
  submitted: EarnVaultWithdrawalRequestRecord;
  observed: EarnVaultWithdrawalRequestRecord | undefined;
  canCancel: (request: EarnVaultWithdrawalRequestRecord) => boolean;
}) {
  const [cancelResult, setCancelResult] = useState<EarnVaultWithdrawalRequestRecord | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const t = useTranslations();
  const request = freshCancelRecord(cancelResult, options.observed, options.submitted);
  const cancelable = options.canCancel(request);

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
