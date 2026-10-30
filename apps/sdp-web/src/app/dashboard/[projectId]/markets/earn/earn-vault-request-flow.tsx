"use client";

import type {
  EarnVaultAsyncWithdrawalTermsRequest,
  EarnVaultWithdrawalRequestRecord,
} from "@sdp/types/earn";
import { Button } from "@sdp/ui/button";
import { Callout } from "@sdp/ui/callout";
import { Loader2Icon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
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

/**
 * The flow machinery the two withdrawal-request dialogs share — the queued
 * exit and the operator (par) redemption both page through details → review →
 * a settled request record created by the same POST, cancelled by the same
 * one, under the same per-tab idempotency keys. The hooks here keep that one
 * lifecycle spelled once: two copies of a value-moving orchestration is how a
 * double-spend guard drifts. The presentational bits at the bottom are also
 * reused by the sibling exit dialogs (the instant exit's review footer, the
 * route chooser's pending row).
 */

type VaultRequestPreviewResult<P> = { kind: "ready"; value: P } | { kind: "unavailable" };

/**
 * The settled-request view's record: local cancellation state wins only until
 * server polling reports a record at least as fresh.
 *
 * Compare freshness as instants, not raw strings: the record schema only
 * types `updatedAt` as a string, so mixed fractional-seconds formatting
 * could order two ISO strings lexicographically against their true order
 * and let a stale poll override a just-confirmed cancel. An unparseable
 * timestamp makes the comparison false, so the server-observed record wins.
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
 * Owns the review-step preview lifecycle: every change to the request intent
 * refetches a preview while the dialog shows the review step, and submit-time
 * errors share this hook's error state so the review view renders one message.
 *
 * Pass a bare module fetcher (`fetchEarnVaultQueuedWithdrawalPreview`), not an
 * inline arrow: the fetcher is an effect dependency, and a new identity every
 * render would refetch on every render.
 */
export function useVaultRequestPreview<I, P>(
  input: I | null,
  active: boolean,
  fetchPreview: (input: I, signal?: AbortSignal) => Promise<VaultRequestPreviewResult<P>>,
  errorKey: MessageKey
) {
  const t = useTranslations();
  const [preview, setPreview] = useState<P | null>(null);
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
        else setError(t(errorKey));
      })
      .finally(() => {
        if (!controller.signal.aborted) setPreviewLoading(false);
      });
    return () => controller.abort();
  }, [active, input, errorKey, fetchPreview, t]);

  return { preview, previewLoading, error, setError };
}

/**
 * Owns the value-moving request submission. Bookkeeping happens before
 * component-local state: the dialog may have unmounted while the POST was in
 * flight. Ambiguous failures preserve the retry key. `fingerprint` derives the
 * request's idempotency key from the fields the caller's flow varies.
 */
export function useVaultRequestSubmission<I extends EarnVaultAsyncWithdrawalTermsRequest>(options: {
  custodyWalletId: string;
  fingerprint: (input: I) => string;
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
    input: I | null,
    preview: { blockingIssues: ReadonlyArray<{ code: string; message: string }> } | null
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
 * Owns the settled-request view model: the record per `freshCancelRecord`
 * above, and the recovery cancel action, which reuses one idempotency key per
 * ambiguous transport attempt. `cancelable` is the caller's rule for when the
 * record may still be cancelled.
 */
export function useVaultRequestResultView(options: {
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

  return { cancel, cancelable, cancelError, cancelling, request };
}

/** The one pending line an Earn dialog draws while a live read lands. */
export function EarnPendingStatus({ children }: { children: ReactNode }) {
  return (
    <div className="mt-5 flex items-center gap-2 text-body text-secondary" role="status">
      <Loader2Icon aria-hidden="true" className="size-4 animate-spin" />
      {children}
    </div>
  );
}

/** The preview's blocking issues, announced as one warning list. */
export function EarnBlockingIssues({
  issues,
  title,
}: {
  issues: ReadonlyArray<{ code: string; message: string }>;
  title: string;
}) {
  return (
    <Callout className="mt-4" live title={title} variant="warning">
      <ul className="list-disc space-y-1 pl-5">
        {issues.map((issue) => (
          <li key={`${issue.code}:${issue.message}`}>{issue.message}</li>
        ))}
      </ul>
    </Callout>
  );
}

/**
 * The review step's actions: an outline Back that stays enabled until the
 * request is in flight, and a primary submit twice its width whose spinner
 * rides the button while submitting.
 */
export function EarnReviewActions({
  backLabel,
  onBack,
  onSubmit,
  submitDisabled,
  submitLabel,
  submitting,
  submittingLabel,
}: {
  backLabel: string;
  onBack: () => void;
  onSubmit: () => void;
  submitDisabled: boolean;
  submitLabel: string;
  submitting: boolean;
  submittingLabel: string;
}) {
  return (
    <div className="mt-6 flex gap-2">
      <Button className="flex-1" disabled={submitting} onClick={onBack} variant="outline">
        {backLabel}
      </Button>
      <Button
        className="flex-[2]"
        disabled={submitDisabled}
        iconLeft={submitting ? <Loader2Icon aria-hidden="true" className="animate-spin" /> : null}
        onClick={onSubmit}
      >
        {submitting ? submittingLabel : submitLabel}
      </Button>
    </div>
  );
}
