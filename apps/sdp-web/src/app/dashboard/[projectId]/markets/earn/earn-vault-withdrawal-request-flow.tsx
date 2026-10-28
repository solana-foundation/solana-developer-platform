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
 * The lifecycle shared by every modal that places a vault withdrawal request
 * (the solver queue and the operator par redemption): a details → review form
 * whose review step refetches a preview, one value-moving submission, and a
 * settled-request view whose recovery cancel reuses one idempotency key per
 * ambiguous transport attempt. Each mechanism modal keeps its own amounts,
 * copy, and result layout; this module owns the flow those have in common so
 * the two cannot drift. (The step rail's pure logic lives in
 * `earn-vault-withdrawal-request-flow-steps.ts`.)
 */

/** A preview read that may be unreadable: a failed or unparseable read is a miss. */
export type EarnVaultRequestPreviewResult<T> =
  | { kind: "ready"; value: T }
  | { kind: "unavailable" };

/**
 * Owns the review-step preview lifecycle: every change to the request intent
 * refetches a preview while the modal shows the review step, and submit-time
 * errors share this hook's error state so the review view renders one message.
 */
export function useEarnVaultRequestPreview<TInput, TPreview>(options: {
  active: boolean;
  fetchPreview: (
    input: TInput,
    signal: AbortSignal
  ) => Promise<EarnVaultRequestPreviewResult<TPreview>>;
  input: TInput | null;
  previewErrorMessage: string;
}) {
  const { active, fetchPreview, input, previewErrorMessage } = options;
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
        else setError(previewErrorMessage);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [active, fetchPreview, input, previewErrorMessage]);

  return { preview, loading, error, setError };
}

/** The part of a preview the submit guard reads, whatever the mechanism. */
type EarnVaultRequestPreviewGuard = { blockingIssues: Array<{ code: string; message: string }> };

/**
 * Owns the value-moving request submission. Bookkeeping happens before
 * component-local state: the modal may have unmounted while the POST was in
 * flight. Ambiguous failures preserve the retry key. `fingerprintInput` names
 * the mechanism's own intent — the fields that make two presses two requests.
 */
export function useEarnVaultRequestSubmission<
  TInput extends EarnVaultAsyncWithdrawalTermsRequest,
>(options: {
  fingerprintInput: (input: TInput, projectId: string | null) => EarnVaultAsyncWithdrawalIntent;
  onRequested?: (request: EarnVaultWithdrawalRequestRecord) => void;
  onSubmissionStart?: VaultSubmissionObserver;
  custodyWalletId: string;
  projectId: string | null;
  setError: (error: string | null) => void;
}) {
  const t = useTranslations();
  const { mutate } = useSWRConfig();
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<EarnVaultQueuedWithdrawalOutcome | null>(null);

  async function submit(input: TInput | null, preview: EarnVaultRequestPreviewGuard | null) {
    if (!input || !preview || preview.blockingIssues.length > 0) return;
    setSubmitting(true);
    const finishSubmission = options.onSubmissionStart?.(options.custodyWalletId);
    options.setError(null);
    try {
      const fingerprint = vaultAsyncWithdrawalRequestFingerprint(
        options.fingerprintInput(input, options.projectId)
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
 * `isCancelable` names the mechanism's own cancel window.
 */
export function useEarnVaultWithdrawalRequestView(options: {
  submitted: EarnVaultWithdrawalRequestRecord;
  observed: EarnVaultWithdrawalRequestRecord | undefined;
  isCancelable: (request: EarnVaultWithdrawalRequestRecord) => boolean;
}) {
  const { isCancelable, observed, submitted } = options;
  const [cancelResult, setCancelResult] = useState<EarnVaultWithdrawalRequestRecord | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const t = useTranslations();
  // Compare freshness as instants, not raw strings: the record schema only
  // types `updatedAt` as a string, so mixed fractional-seconds formatting
  // could order two ISO strings lexicographically against their true order
  // and let a stale poll override a just-confirmed cancel. An unparseable
  // timestamp makes the comparison false, so the server-observed record wins.
  const cancelIsFresh =
    cancelResult !== null &&
    (!observed || Date.parse(cancelResult.updatedAt) >= Date.parse(observed.updatedAt));
  const request = cancelIsFresh ? cancelResult : (observed ?? submitted);
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

/** The form-step heading, spelled once with the modal's focus target on it. */
export function EarnRequestFlowHeading({ children }: { children: ReactNode }) {
  return (
    <h2
      className="pr-8 text-subheading font-medium text-primary"
      data-modal-focus-target
      tabIndex={-1}
    >
      {children}
    </h2>
  );
}

/** The review step's pending row while a preview refetches. */
export function EarnRequestPreviewLoading({ label }: { label: string }) {
  return (
    <div className="mt-5 flex items-center gap-2 text-body text-secondary" role="status">
      <Loader2Icon aria-hidden="true" className="size-4 animate-spin" />
      {label}
    </div>
  );
}

/** Why the provider refused to quote this request, one listed issue at a time. */
export function EarnRequestBlockingIssues({
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
 * The review step's Back / submit pair. Submit is disabled while submitting,
 * while the preview refetches, and whenever the preview has no quote or the
 * provider named blocking issues.
 */
export function EarnRequestFlowActions({
  backLabel,
  onBack,
  onSubmit,
  preview,
  previewLoading,
  submitting,
  submitLabel,
  submittingLabel,
}: {
  backLabel: string;
  onBack: () => void;
  onSubmit: () => void;
  preview: EarnVaultRequestPreviewGuard | null;
  previewLoading: boolean;
  submitting: boolean;
  submitLabel: string;
  submittingLabel: string;
}) {
  return (
    <div className="mt-6 flex gap-2">
      <Button className="flex-1" disabled={submitting} onClick={onBack} variant="outline">
        {backLabel}
      </Button>
      <Button
        className="flex-[2]"
        disabled={submitting || previewLoading || !preview || preview.blockingIssues.length > 0}
        iconLeft={submitting ? <Loader2Icon aria-hidden="true" className="animate-spin" /> : null}
        onClick={onSubmit}
      >
        {submitting ? submittingLabel : submitLabel}
      </Button>
    </div>
  );
}
