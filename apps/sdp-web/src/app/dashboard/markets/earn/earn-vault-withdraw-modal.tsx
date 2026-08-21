"use client";

import {
  CLUSTER_BY_SDP_ENVIRONMENT,
  type EarnVaultPosition,
  type SdpEnvironment,
} from "@sdp/types";
import { ExternalLinkIcon, Loader2Icon } from "lucide-react";
import { type ChangeEvent, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { useLocale, useTranslations } from "@/i18n/provider";
import { explorerTxUrl } from "@/lib/explorer";
import { useModalFocus } from "@/lib/use-modal-focus";
import { compareUnsignedDecimals, parseUnsignedDecimal } from "./earn-decimal";
import { formatTokenQuantity, tokenSymbol } from "./earn-format";
import { answerRetiresIdempotencyKey } from "./earn-idempotency-key-store";
import {
  earnMintAsset,
  formatProviderAmount,
  shortenMarketAddress,
} from "./earn-market-presentation";
import {
  createEarnVaultWithdrawal,
  type EarnVaultWithdrawal,
  type EarnVaultWithdrawalTransaction,
  fetchEarnVaultWithdrawalsByRequestId,
  useEarnVaultWithdrawalOutcomeToast,
} from "./earn-program-data";
import {
  claimVaultWithdrawalIdempotencyKey,
  holdVaultWithdrawalIdempotencyKey,
  isVaultWithdrawalIdempotencyKeyHeld,
  releaseVaultWithdrawalIdempotencyKey,
  vaultWithdrawalRequestFingerprint,
} from "./earn-vault-withdraw-tracking";

const MAX_SHARES_LENGTH = 128;

export type VaultWithdrawalSharesValidation =
  | { kind: "valid"; canonicalShares: string }
  | { kind: "invalid" };

/**
 * Validate a share quantity without converting it through a JavaScript number.
 * The share mint's scale is not knowable client-side (share mints are not in
 * the well-known token table), so scale is the BUILDER's check: the API
 * answers over-precision with a readable 400 before anything is signed.
 */
export function validateVaultWithdrawalShares(value: string): VaultWithdrawalSharesValidation {
  const shares = parseUnsignedDecimal(value, { maxLength: MAX_SHARES_LENGTH });
  if (!shares || compareUnsignedDecimals(shares.canonical, "0") !== 1) {
    return { kind: "invalid" };
  }
  return { kind: "valid", canonicalShares: shares.canonical };
}

type WithdrawalOutcome =
  | {
      kind: "approval_pending";
      approvalRequestId?: string;
      walletOperationId?: string;
    }
  | {
      kind: "withdrawal";
      withdrawal: EarnVaultWithdrawal;
      /**
       * The approval executor won the race between the held-key pre-flight and
       * this POST: real money DID move — once, via the approval — but THIS
       * submission moved nothing. Same rule as the deposit's absorbed case.
       */
      absorbedByApproval?: true;
    };

type WithdrawalSubmissionResolution =
  | { kind: "error"; message: string }
  | { kind: "outcome"; outcome: WithdrawalOutcome; withdrawn?: EarnVaultWithdrawal };

function resolveWithdrawalSubmission(
  result: Awaited<ReturnType<typeof createEarnVaultWithdrawal>>,
  fallbackError: string,
  keyWasHeld: boolean
): WithdrawalSubmissionResolution {
  if (!result.ok) {
    return { kind: "error", message: result.error || fallbackError };
  }
  if (result.data.kind === "approval_pending") {
    return {
      kind: "outcome",
      outcome: {
        kind: "approval_pending",
        ...(result.data.approvalRequestId
          ? { approvalRequestId: result.data.approvalRequestId }
          : {}),
        ...(result.data.walletOperationId
          ? { walletOperationId: result.data.walletOperationId }
          : {}),
      },
    };
  }

  const withdrawal = result.data.withdrawal;
  if (withdrawal.status === "failed") {
    return {
      kind: "error",
      message: withdrawal.failureReason || fallbackError,
    };
  }
  if (withdrawal.replayed && keyWasHeld) {
    return {
      kind: "outcome",
      outcome: { kind: "withdrawal", withdrawal, absorbedByApproval: true },
      withdrawn: withdrawal,
    };
  }
  return { kind: "outcome", outcome: { kind: "withdrawal", withdrawal }, withdrawn: withdrawal };
}

/**
 * The key to send for this request — the deposit path's resolution, mirrored:
 * an unheld key needs no round trip, a HELD key is checked against the server
 * before reuse (a movement under it means the approval executed and the key is
 * spent), and an unanswerable check REFUSES rather than guessing in either
 * direction over someone's funds.
 */
type VaultWithdrawalKeyResolution =
  | { kind: "key"; key: string; wasHeld: boolean }
  | { kind: "aborted" }
  | { kind: "unavailable" };

async function resolveVaultWithdrawalIdempotencyKey(
  fingerprint: string,
  signal: AbortSignal
): Promise<VaultWithdrawalKeyResolution> {
  const key = claimVaultWithdrawalIdempotencyKey(fingerprint);
  if (!isVaultWithdrawalIdempotencyKeyHeld(fingerprint)) {
    return { kind: "key", key, wasHeld: false };
  }

  const recorded = await fetchEarnVaultWithdrawalsByRequestId(key);
  if (signal.aborted) return { kind: "aborted" };
  if (recorded.kind === "unavailable") return { kind: "unavailable" };
  if (recorded.kind === "absent") return { kind: "key", key, wasHeld: true };

  releaseVaultWithdrawalIdempotencyKey(fingerprint);
  return { kind: "key", key: claimVaultWithdrawalIdempotencyKey(fingerprint), wasHeld: false };
}

/** Retire, pin, or keep the key for the answer the API gave — one place. */
function applyVaultWithdrawalIdempotencyKeyOutcome(
  fingerprint: string,
  result: Awaited<ReturnType<typeof createEarnVaultWithdrawal>>
): void {
  if (answerRetiresIdempotencyKey(result.ok ? result : { ...result, data: undefined })) {
    releaseVaultWithdrawalIdempotencyKey(fingerprint);
    return;
  }
  if (result.ok && result.data.kind === "approval_pending") {
    holdVaultWithdrawalIdempotencyKey(fingerprint);
  }
}

function TransactionList({
  transactions,
  environment,
}: {
  transactions: EarnVaultWithdrawalTransaction[];
  environment: SdpEnvironment;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const cluster = CLUSTER_BY_SDP_ENVIRONMENT[environment];

  return (
    <dl className="mt-5 rounded-lg border border-border-default bg-fill-subtle p-4 text-sm">
      {transactions.map((transaction) => (
        <div
          className="flex items-baseline justify-between gap-5 py-1"
          key={transaction.signature}
        >
          <dt className="text-tertiary">
            {transactions.length > 1
              ? t("DashboardEarn.vaultWithdraw.legLabel", {
                  index: transaction.index + 1,
                  count: transactions.length,
                })
              : t("DashboardEarn.vaultWithdraw.transaction")}
          </dt>
          <dd className="text-right">
            <span className="mr-3 tabular-nums text-secondary">
              {t("DashboardEarn.vaultWithdraw.legShares", {
                shares: formatProviderAmount(transaction.shares, locale),
              })}
            </span>
            <a
              className="inline-flex items-center gap-1 text-primary underline underline-offset-2"
              href={explorerTxUrl(transaction.signature, cluster)}
              rel="noreferrer"
              target="_blank"
            >
              {shortenMarketAddress(transaction.signature)}
              <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
            </a>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function WithdrawalResult({
  outcome,
  environment,
  onClose,
}: {
  outcome: WithdrawalOutcome;
  environment: SdpEnvironment;
  onClose: () => void;
}) {
  const t = useTranslations();

  if (outcome.kind === "approval_pending") {
    return (
      <>
        <h2
          className="text-base font-medium text-primary outline-none"
          data-modal-focus-target
          tabIndex={-1}
        >
          {t("DashboardEarn.vaultWithdraw.approvalTitle")}
        </h2>
        <p className="mt-1 text-sm leading-6 text-secondary">
          {t("DashboardEarn.vaultWithdraw.approvalBody")}
        </p>
        {outcome.approvalRequestId || outcome.walletOperationId ? (
          <dl className="mt-5 rounded-lg border border-border-default bg-fill-subtle p-4 text-sm">
            {outcome.approvalRequestId ? (
              <div className="flex items-start justify-between gap-5 py-1">
                <dt className="text-tertiary">{t("DashboardEarn.deposit.vaultApprovalRequest")}</dt>
                <dd className="max-w-64 break-all text-right text-primary">
                  {outcome.approvalRequestId}
                </dd>
              </div>
            ) : null}
            {outcome.walletOperationId ? (
              <div className="flex items-start justify-between gap-5 py-1">
                <dt className="text-tertiary">{t("DashboardEarn.withdraw.referenceLabel")}</dt>
                <dd className="max-w-64 break-all text-right text-primary">
                  {outcome.walletOperationId}
                </dd>
              </div>
            ) : null}
          </dl>
        ) : null}
        <div className="mt-6 flex justify-end">
          <Button onClick={onClose}>{t("DashboardEarn.withdraw.done")}</Button>
        </div>
      </>
    );
  }

  const { withdrawal } = outcome;
  const multiLeg = withdrawal.transactions.length > 1;
  const copy = outcome.absorbedByApproval
    ? {
        title: t("DashboardEarn.vaultWithdraw.absorbedTitle"),
        body: t("DashboardEarn.vaultWithdraw.absorbedBody"),
        note: t("DashboardEarn.vaultWithdraw.absorbedNote"),
      }
    : {
        title: t("DashboardEarn.vaultWithdraw.submittedTitle"),
        body: multiLeg
          ? t("DashboardEarn.vaultWithdraw.submittedBodyMultiLeg", {
              count: withdrawal.transactions.length,
            })
          : t("DashboardEarn.vaultWithdraw.submittedBody"),
        note: t("DashboardEarn.vaultWithdraw.settlingNote"),
      };

  return (
    <>
      <h2
        className="text-base font-medium text-primary outline-none"
        data-modal-focus-target
        tabIndex={-1}
      >
        {copy.title}
      </h2>
      <p className="mt-1 text-sm leading-6 text-secondary">{copy.body}</p>
      <TransactionList environment={environment} transactions={withdrawal.transactions} />
      <p className="mt-4 text-sm leading-6 text-secondary">{copy.note}</p>
      <div className="mt-6 flex justify-end">
        <Button onClick={onClose}>{t("DashboardEarn.withdraw.done")}</Button>
      </div>
    </>
  );
}

interface EarnVaultWithdrawalOutcomeTrackerProps {
  movementId: string;
  /** Refresh the balances the exit changed, then retire the tracker. */
  onSettled?: () => void;
}

/**
 * Keeps one logical withdrawal under observation independently of the
 * dismissible modal. The canonical hook polls the parent movement until every
 * internal transaction reaches a terminal result.
 */
export function EarnVaultWithdrawalOutcomeTracker({
  movementId,
  onSettled,
}: EarnVaultWithdrawalOutcomeTrackerProps) {
  useEarnVaultWithdrawalOutcomeToast(movementId, onSettled);
  return null;
}

export interface EarnVaultWithdrawModalProps {
  position: EarnVaultPosition;
  environment: SdpEnvironment;
  /** Part of the request fingerprint — see `vaultWithdrawalRequestFingerprint`. */
  projectId: string | null;
  onClose: () => void;
  onWithdrawn?: (withdrawal: EarnVaultWithdrawal) => void;
}

/**
 * Exit a vault position: redeem shares back into the custody wallet that holds
 * them. Shares, not token amounts — the share quantity is the exact intent a
 * withdrawal has, and the live position read is the balance that bounds it.
 * The proceeds arrive as the position's deposit token in the same wallet; no
 * destination is ever entered here.
 */
export function EarnVaultWithdrawModal({
  position,
  environment,
  projectId,
  onClose,
  onWithdrawn,
}: EarnVaultWithdrawModalProps) {
  const t = useTranslations();
  const locale = useLocale();
  const [sharesInput, setSharesInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<WithdrawalOutcome | null>(null);
  const submittingRef = useRef(false);
  const requestControllerRef = useRef<AbortController | null>(null);
  const panelKey = outcome ? `outcome:${outcome.kind}` : "form";
  const contentRef = useModalFocus({
    focusKey: panelKey,
    initialFocusSelector: "[data-modal-focus-target]",
    fallbackAttribute: "data-earn-vault-withdraw-focus-fallback",
    fallbackValue: position.id,
    contentDataKey: "panel",
  });

  // Unmount "aborts" the SUBMISSION, not the request — same contract as the
  // deposit modal: the POST runs to completion so its answer reaches the key
  // store, and the signal only gates state updates.
  useEffect(
    () => () => {
      requestControllerRef.current?.abort();
    },
    []
  );

  const asset = earnMintAsset(position.tokenMint);
  const shareSymbol = tokenSymbol(position.shareMint);
  const sharesValidation = validateVaultWithdrawalShares(sharesInput);
  const knownShares = position.shares;
  const overKnownShares =
    sharesValidation.kind === "valid" && knownShares !== undefined
      ? compareUnsignedDecimals(sharesValidation.canonicalShares, knownShares) === 1
      : false;
  const sharesError =
    sharesInput.trim() === "" || sharesValidation.kind === "valid"
      ? null
      : t("DashboardEarn.vaultWithdraw.sharesInvalid");

  async function submit() {
    if (submittingRef.current || sharesValidation.kind !== "valid") return;

    const shares = sharesValidation.canonicalShares;
    const fingerprint = vaultWithdrawalRequestFingerprint({
      projectId,
      positionId: position.id,
      shares,
    });
    const controller = new AbortController();
    requestControllerRef.current?.abort();
    requestControllerRef.current = controller;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);

    try {
      const resolvedKey = await resolveVaultWithdrawalIdempotencyKey(
        fingerprint,
        controller.signal
      );
      if (resolvedKey.kind === "aborted") return;
      if (resolvedKey.kind === "unavailable") {
        setSubmitError(t("DashboardEarn.vaultWithdraw.heldKeyUnavailable"));
        return;
      }

      // No abort signal on the value-moving POST — see the deposit modal.
      const result = await createEarnVaultWithdrawal(
        { positionId: position.id, shares },
        resolvedKey.key
      );
      // Key bookkeeping FIRST and unconditionally: the store outlives the
      // component, so an unmount mid-flight must not skip recording the answer.
      applyVaultWithdrawalIdempotencyKeyOutcome(fingerprint, result);
      if (controller.signal.aborted) return;
      const resolution = resolveWithdrawalSubmission(
        result,
        t("DashboardEarn.vaultWithdraw.submitError"),
        resolvedKey.wasHeld
      );
      if (resolution.kind === "error") {
        setSubmitError(resolution.message);
        return;
      }
      setOutcome(resolution.outcome);
      if (resolution.withdrawn) onWithdrawn?.(resolution.withdrawn);
    } catch (cause) {
      if (!controller.signal.aborted) {
        setSubmitError(
          cause instanceof Error && cause.message
            ? cause.message
            : t("DashboardEarn.vaultWithdraw.submitError")
        );
      }
    } finally {
      if (requestControllerRef.current === controller) requestControllerRef.current = null;
      submittingRef.current = false;
      if (!controller.signal.aborted) setSubmitting(false);
    }
  }

  const modalLabel = t("DashboardEarn.vaultWithdraw.title", {
    position: position.label || shortenMarketAddress(position.providerReference),
  });

  if (outcome) {
    return (
      <Modal isOpen ariaLabel={modalLabel} onClose={onClose} size="md">
        <div className="p-6" ref={contentRef}>
          <WithdrawalResult environment={environment} onClose={onClose} outcome={outcome} />
        </div>
      </Modal>
    );
  }

  return (
    <Modal isOpen ariaLabel={modalLabel} closeDisabled={submitting} onClose={onClose} size="md">
      <div aria-busy={submitting} className="p-6" ref={contentRef}>
        <h2
          className="text-base font-medium text-primary outline-none"
          data-modal-focus-target
          tabIndex={-1}
        >
          {modalLabel}
        </h2>
        <p className="mt-1 text-sm leading-6 text-secondary">
          {t("DashboardEarn.vaultWithdraw.body", { token: asset.symbol })}
        </p>

        <div className="mt-5 space-y-2">
          <div className="flex items-end justify-between gap-3">
            <Label htmlFor="earn-vault-withdraw-shares">
              {t("DashboardEarn.vaultWithdraw.sharesLabel")}
            </Label>
            {knownShares !== undefined ? (
              <Button
                disabled={submitting}
                onClick={() => {
                  setSharesInput(knownShares);
                  setSubmitError(null);
                }}
                size="sm"
                type="button"
                variant="ghost"
              >
                {t("DashboardEarn.vaultWithdraw.max")}
              </Button>
            ) : null}
          </div>
          <Input
            aria-describedby="earn-vault-withdraw-balance earn-vault-withdraw-note"
            aria-invalid={sharesError ? true : undefined}
            disabled={submitting}
            id="earn-vault-withdraw-shares"
            inputMode="decimal"
            maxLength={MAX_SHARES_LENGTH}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              setSharesInput(event.target.value);
              setSubmitError(null);
            }}
            placeholder="0.00"
            value={sharesInput}
          />
          <div className="min-h-5 text-xs text-tertiary" id="earn-vault-withdraw-balance">
            {knownShares === undefined
              ? t("DashboardEarn.vaultWithdraw.sharesUnknown")
              : t("DashboardEarn.vaultWithdraw.sharesHeld", {
                  shares: formatProviderAmount(knownShares, locale),
                })}
          </div>
          {sharesError ? (
            <p className="text-xs text-error" role="alert">
              {sharesError}
            </p>
          ) : null}
          {overKnownShares ? (
            <p className="text-xs text-warning" role="status">
              {t("DashboardEarn.vaultWithdraw.overShares")}
            </p>
          ) : null}
        </div>

        <dl className="mt-5 rounded-lg border border-border-default bg-fill-subtle p-4 text-sm">
          <div className="flex items-baseline justify-between gap-5 py-1">
            <dt className="text-tertiary">{t("DashboardEarn.deposit.vaultStrategy")}</dt>
            <dd className="text-right text-primary">
              {position.label || shortenMarketAddress(position.providerReference)}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-5 py-1">
            <dt className="text-tertiary">{t("DashboardEarn.vaultWithdraw.receiveAs")}</dt>
            <dd className="text-right text-primary">{asset.symbol}</dd>
          </div>
          {position.tokenValue !== undefined ? (
            <div className="flex items-baseline justify-between gap-5 py-1">
              <dt className="text-tertiary">{t("DashboardEarn.vaultWithdraw.positionValue")}</dt>
              <dd className="text-right tabular-nums text-primary">
                {formatTokenQuantity(position.tokenValue, locale, asset.symbol)}
              </dd>
            </div>
          ) : null}
        </dl>

        <p className="mt-4 text-sm leading-6 text-secondary" id="earn-vault-withdraw-note">
          {t("DashboardEarn.vaultWithdraw.confirmNote", { symbol: shareSymbol })}
        </p>
        {submitError ? (
          <p
            className="mt-3 rounded-lg border border-destructive-border bg-destructive-bg p-3 text-sm text-error"
            role="alert"
          >
            {submitError}
          </p>
        ) : null}

        <div className="mt-6 flex justify-end gap-2">
          <Button disabled={submitting} onClick={onClose} variant="outline">
            {t("DashboardEarn.deposit.cancel")}
          </Button>
          <Button
            disabled={submitting || sharesValidation.kind !== "valid"}
            onClick={() => void submit()}
          >
            {submitting ? (
              <span className="inline-flex items-center gap-2">
                <Loader2Icon aria-hidden="true" className="size-4 animate-spin" />
                {t("DashboardEarn.vaultWithdraw.submitting")}
              </span>
            ) : (
              t("DashboardEarn.vaultWithdraw.submit")
            )}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
