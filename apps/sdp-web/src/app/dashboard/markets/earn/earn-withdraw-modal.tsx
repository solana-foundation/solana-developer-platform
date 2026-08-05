"use client";

import {
  EARN_PORTFOLIO_TOKENS,
  type EarnPortfolioBalance,
  type EarnPortfolioPosition,
  type EarnPortfolioToken,
  type EarnPortfolioWithdrawal,
  type EarnPortfolioWithdrawalPreview,
} from "@sdp/types";
import { Loader2Icon } from "lucide-react";
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { Select, SelectItem } from "@/components/ui/select";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { formatDurationRange, formatUsd, isoDurationDays } from "./earn-format";
import {
  createEarnWithdrawal,
  previewEarnWithdrawal,
  useEarnStrategies,
} from "./earn-program-data";
import { withdrawLanes } from "./earn-program-presentation";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Positive USD decimal with at most 6 decimal places (the API's contract). */
const USD_AMOUNT_PATTERN = /^\d+(\.\d{1,6})?$/;

/** Base58 Solana address shape; the API re-validates with a real decoder. */
const SOLANA_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const PREVIEW_DEBOUNCE_MS = 400;

/**
 * Stablecoins Ground pays out on the Solana rail (docs: supported-chains —
 * "Solana = USDC deposits and withdrawals only"). SDP's surface is Solana-only,
 * so a token outside this set cannot complete a withdrawal here at all.
 */
const SOLANA_PAYOUT_TOKENS: ReadonlySet<EarnPortfolioToken> = new Set(["usdc"]);

const WITHDRAWAL_STATUS_BADGES: Record<
  EarnPortfolioWithdrawal["status"],
  { variant: "success" | "warning" | "danger"; key: MessageKey }
> = {
  processing: { variant: "warning", key: "DashboardEarn.withdraw.statusProcessing" },
  completed: { variant: "success", key: "DashboardEarn.withdraw.statusCompleted" },
  partially_completed: {
    variant: "warning",
    key: "DashboardEarn.withdraw.statusPartiallyCompleted",
  },
  failed: { variant: "danger", key: "DashboardEarn.withdraw.statusFailed" },
  cancelled: { variant: "danger", key: "DashboardEarn.withdraw.statusCancelled" },
};

/** Scope focus to the portaled Earn dialog and return it to the trigger on close. */
function useEarnModalFocus() {
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const returnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusFrame = window.requestAnimationFrame(() => {
      contentRef.current
        ?.querySelector<HTMLElement>('input:not([type="hidden"]):not([disabled])')
        ?.focus();
    });

    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const dialog = contentRef.current?.closest<HTMLElement>('[role="dialog"]');
      if (!dialog?.contains(document.activeElement)) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
        (element) => element.getAttribute("aria-hidden") !== "true"
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (!focusable.includes(document.activeElement as HTMLElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", trapFocus);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", trapFocus);
      window.requestAnimationFrame(() => {
        const focusTarget = returnFocus?.isConnected
          ? returnFocus
          : document.querySelector<HTMLElement>("[data-earn-withdraw-focus-fallback]");
        focusTarget?.focus();
      });
    };
  }, []);

  return contentRef;
}

type PreviewState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ready"; preview: EarnPortfolioWithdrawalPreview }
  | { phase: "error" };

function ProcessingEstimateLine({
  estimate,
}: {
  estimate: NonNullable<EarnPortfolioWithdrawalPreview["processingEstimate"]>;
}) {
  const t = useTranslations();
  if (estimate.basis === "banking_days") {
    const min = isoDurationDays(estimate.typicalMinDuration);
    const max = isoDurationDays(estimate.typicalMaxDuration);
    if (min !== undefined && max !== undefined) {
      return (
        <p className="mt-1 text-xs text-tertiary">
          {t("DashboardEarn.withdraw.previewProcessingBankingDays", { min, max })}
        </p>
      );
    }
  }
  return (
    <p className="mt-1 text-xs text-tertiary">
      {t("DashboardEarn.withdraw.previewProcessing", {
        range: formatDurationRange(estimate.typicalMinDuration, estimate.typicalMaxDuration),
      })}
    </p>
  );
}

function WithdrawPreviewPanel({
  preview,
  token,
}: {
  preview: PreviewState;
  token: EarnPortfolioToken;
}) {
  const t = useTranslations();
  if (preview.phase === "idle") return null;
  return (
    <div className="mt-4 rounded-md border border-border-default bg-fill-subtle p-3">
      <p className="text-xs font-medium text-primary">{t("DashboardEarn.withdraw.previewTitle")}</p>
      {preview.phase === "loading" ? (
        <p className="mt-1 text-xs text-secondary">{t("DashboardEarn.withdraw.previewLoading")}</p>
      ) : null}
      {preview.phase === "error" ? (
        // Translated, never the provider's wire text — and cause-specific,
        // because the two failure modes are token-determined, not mixed:
        // a Solana-payable token can only fail on lane funds, while a token
        // Ground never routes to Solana (USDT, per their supported-chains
        // doc) always fails on routing regardless of balance.
        <p className="mt-1 text-xs text-error" role="alert">
          {t(
            SOLANA_PAYOUT_TOKENS.has(token)
              ? "DashboardEarn.withdraw.previewInsufficient"
              : "DashboardEarn.withdraw.previewNoSolanaPayout",
            { token: token.toUpperCase() }
          )}
        </p>
      ) : null}
      {preview.phase === "ready" ? (
        <>
          <dl className="mt-1 text-xs">
            <div className="flex items-baseline justify-between gap-4 py-1">
              <dt className="text-tertiary">{t("DashboardEarn.withdraw.previewFee")}</dt>
              <dd className="text-primary tabular-nums">{formatUsd(preview.preview.feeUsd)}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4 py-1">
              <dt className="text-tertiary">{t("DashboardEarn.withdraw.previewTotalAfter")}</dt>
              <dd className="text-primary tabular-nums">
                {formatUsd(preview.preview.totalUsdAfterWithdrawal)}
              </dd>
            </div>
          </dl>
          {preview.preview.processingEstimate ? (
            <ProcessingEstimateLine estimate={preview.preview.processingEstimate} />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function WithdrawalCreatedView({
  withdrawal,
  fallbackAmountUsd,
  token,
  onClose,
}: {
  withdrawal: EarnPortfolioWithdrawal;
  fallbackAmountUsd: string;
  token: EarnPortfolioToken;
  onClose: () => void;
}) {
  const t = useTranslations();
  const badge = WITHDRAWAL_STATUS_BADGES[withdrawal.status];
  return (
    <>
      <div className="flex items-center gap-2">
        <h2 className="text-base font-medium text-primary">
          {t("DashboardEarn.withdraw.createdTitle")}
        </h2>
        <Badge variant={badge.variant}>{t(badge.key)}</Badge>
      </div>
      <p className="mt-1 text-sm leading-6 text-secondary">
        {t("DashboardEarn.withdraw.createdDescription")}
      </p>

      <dl className="mt-4 rounded-md border border-border-default bg-fill-subtle p-3 text-xs">
        <div className="flex items-baseline justify-between gap-4 py-1">
          <dt className="text-tertiary">{t("DashboardEarn.withdraw.amountLabel")}</dt>
          <dd className="text-primary tabular-nums">
            {formatUsd(withdrawal.amountRequestedUsd ?? fallbackAmountUsd)} · {token.toUpperCase()}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-4 py-1">
          <dt className="text-tertiary">{t("DashboardEarn.withdraw.destinationLabel")}</dt>
          <dd className="max-w-52 truncate text-primary" title={withdrawal.destinationAddress}>
            {withdrawal.destinationAddress}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-4 py-1">
          <dt className="text-tertiary">{t("DashboardEarn.withdraw.referenceLabel")}</dt>
          <dd className="max-w-52 truncate text-primary" title={withdrawal.withdrawalRef}>
            {withdrawal.withdrawalRef}
          </dd>
        </div>
      </dl>

      <div className="mt-5 flex justify-end">
        <Button onClick={onClose}>{t("DashboardEarn.withdraw.done")}</Button>
      </div>
    </>
  );
}

interface EarnWithdrawModalProps {
  balance: EarnPortfolioBalance;
  /** Live portfolio slices; power the per-stablecoin available figures. */
  positions: readonly EarnPortfolioPosition[];
  onClose: () => void;
  /** Fired once a withdrawal is accepted, so the caller can refresh balances. */
  onWithdrawalCreated: () => void;
}

/**
 * Portfolio-level withdrawal against the shared Ground program wallet: one
 * USD amount + stablecoin + Solana destination. A live preview (fees and the
 * provider's typical processing window) precedes confirmation; the accepted
 * withdrawal stays on screen in its processing state.
 */
export function EarnWithdrawModal({
  balance,
  positions,
  onClose,
  onWithdrawalCreated,
}: EarnWithdrawModalProps) {
  const t = useTranslations();
  const contentRef = useEarnModalFocus();
  const { strategies } = useEarnStrategies();
  const [amountInput, setAmountInput] = useState("");
  // Always USDC: the one stablecoin Ground pays out on Solana, so it is the
  // right anchor regardless of where the balance happens to sit.
  const [token, setToken] = useState<EarnPortfolioToken>("usdc");
  const [destinationInput, setDestinationInput] = useState("");
  const [preview, setPreview] = useState<PreviewState>({ phase: "idle" });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [created, setCreated] = useState<EarnPortfolioWithdrawal | null>(null);

  const walletWithdrawable = Number(balance.withdrawableUsd);
  // Everything the modal promises is scoped to the SELECTED token, because
  // Ground fills withdrawals per stablecoin lane while `withdrawableUsd` is
  // wallet-level — quoting the wallet figure invited "Max" to fill an amount
  // the selected lane could never pay. Lane-unresolved value widens every
  // lane's ceiling (never narrows it), so this can only degrade toward the
  // old wallet-level behaviour; the preview stays the authority.
  const lanes = useMemo(() => withdrawLanes(positions, strategies ?? []), [positions, strategies]);
  const availableUsdFor = (candidate: EarnPortfolioToken) =>
    Math.min(walletWithdrawable, (lanes.totals.get(candidate) ?? 0) + lanes.unattributedUsd);
  const tokenAvailable = availableUsdFor(token);
  // As an input value: an exact provider string when wallet-capped, else the
  // lane sum trimmed to the API's 6-decimal contract.
  const tokenAvailableInput =
    tokenAvailable === walletWithdrawable
      ? balance.withdrawableUsd
      : tokenAvailable
          .toFixed(6)
          .replace(/(\.\d*?)0+$/, "$1")
          .replace(/\.$/, "");
  // A token Ground never routes to Solana (USDT: Ethereum only, per their
  // supported-chains doc) cannot withdraw here at all — say so at selection
  // instead of letting a filled-in form debounce into a provider refusal.
  const payoutBlocked = !SOLANA_PAYOUT_TOKENS.has(token);

  const amount = amountInput.trim();
  const amountShapeValid = USD_AMOUNT_PATTERN.test(amount) && Number(amount) > 0;
  const amountValid = amountShapeValid && Number(amount) <= tokenAvailable;
  const destination = destinationInput.trim();
  const destinationValid = SOLANA_ADDRESS_PATTERN.test(destination);

  /**
   * The idempotency key identifies ONE intended withdrawal, so it is bound to
   * the parameters that define it. Retrying an unchanged confirm reuses the key
   * (the provider collapses the duplicate instead of paying twice); editing the
   * amount, token, or destination after a failed attempt mints a new key, so a
   * corrected withdrawal can never be answered with the cached result of the
   * one the user just fixed — which would settle funds to the old address while
   * reporting success.
   *
   * A ref, not `useMemo`: React may discard a memo cache and recompute, which
   * would hand the same parameters a fresh key and reintroduce the
   * double-withdraw risk on retry.
   */
  const requestSignature = `${amount}|${token}|${destination}`;
  const requestRef = useRef<{ signature: string; id: string } | null>(null);
  if (requestRef.current?.signature !== requestSignature) {
    requestRef.current = { signature: requestSignature, id: crypto.randomUUID() };
  }
  const requestId = requestRef.current.id;

  useEffect(() => {
    if (submitting) contentRef.current?.focus();
  }, [submitting, contentRef]);

  // The preview needs only amount + token, so it refreshes as those settle.
  useEffect(() => {
    if (!amountValid || payoutBlocked || created) {
      setPreview({ phase: "idle" });
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setPreview({ phase: "loading" });
      const result = await previewEarnWithdrawal({ amountUsd: amount, token }, controller.signal);
      if (controller.signal.aborted) return;
      setPreview(
        result.ok ? { phase: "ready", preview: result.data.data.preview } : { phase: "error" }
      );
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [amount, amountValid, token, payoutBlocked, created]);

  const submit = async () => {
    if (!amountValid || !destinationValid || payoutBlocked || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    const result = await createEarnWithdrawal({
      requestId,
      amountUsd: amount,
      token,
      destinationAddress: destination,
    });
    setSubmitting(false);
    if (!result.ok) {
      setSubmitError(result.error);
      return;
    }
    setCreated(result.data.data.withdrawal);
    onWithdrawalCreated();
  };

  if (created) {
    return (
      <Modal
        isOpen
        ariaLabel={t("DashboardEarn.withdraw.createdTitle")}
        onClose={onClose}
        size="sm"
      >
        <div ref={contentRef} className="p-5">
          <WithdrawalCreatedView
            withdrawal={created}
            fallbackAmountUsd={amount}
            token={token}
            onClose={onClose}
          />
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      isOpen
      ariaLabel={t("DashboardEarn.withdraw.title")}
      onClose={onClose}
      closeDisabled={submitting}
      size="sm"
    >
      <div ref={contentRef} className="p-5" tabIndex={submitting ? 0 : -1} aria-busy={submitting}>
        <h2 className="text-base font-medium text-primary">{t("DashboardEarn.withdraw.title")}</h2>
        <p className="mt-0.5 text-sm leading-5 text-secondary">
          {t("DashboardEarn.withdraw.description")}
        </p>

        {/* Token FIRST: it scopes everything below. Each option carries its
            lane's figure, so the choice is made on facts rather than
            discovered as a refusal after typing an amount. */}
        <div className="mt-4 space-y-2">
          <p className="text-sm font-medium text-primary">
            {t("DashboardEarn.withdraw.tokenLabel")}
          </p>
          <Select
            ariaLabel={t("DashboardEarn.withdraw.tokenLabel")}
            value={token}
            disabled={submitting}
            onValueChange={(nextToken) => {
              if (!nextToken || nextToken === token) return;
              setToken(nextToken as EarnPortfolioToken);
              // A different lane is different money — an amount typed against
              // one says nothing about the other.
              setAmountInput("");
            }}
          >
            {EARN_PORTFOLIO_TOKENS.map((candidate) => (
              <SelectItem key={candidate} value={candidate}>
                {t(
                  SOLANA_PAYOUT_TOKENS.has(candidate)
                    ? "DashboardEarn.withdraw.tokenOption"
                    : "DashboardEarn.withdraw.tokenOptionNoPayout",
                  {
                    token: candidate.toUpperCase(),
                    amount: formatUsd(availableUsdFor(candidate)),
                  }
                )}
              </SelectItem>
            ))}
          </Select>
          {payoutBlocked ? (
            <p className="text-xs leading-5 text-error" role="alert">
              {t("DashboardEarn.withdraw.previewNoSolanaPayout", { token: token.toUpperCase() })}
            </p>
          ) : null}
        </div>

        <div className="mt-4 space-y-2">
          <Label htmlFor="earn-withdraw-amount">{t("DashboardEarn.withdraw.amountLabel")}</Label>
          <Input
            size="lg"
            id="earn-withdraw-amount"
            inputMode="decimal"
            placeholder="0.00"
            disabled={submitting || payoutBlocked}
            value={amountInput}
            aria-invalid={Boolean(amountInput && !amountValid)}
            aria-describedby={
              amountInput && !amountValid
                ? "earn-withdraw-available earn-withdraw-error"
                : "earn-withdraw-available"
            }
            onChange={(event: ChangeEvent<HTMLInputElement>) => setAmountInput(event.target.value)}
            iconRight={
              <button
                type="button"
                disabled={submitting || payoutBlocked || tokenAvailable <= 0}
                onClick={() => setAmountInput(tokenAvailableInput)}
                className="pointer-events-auto text-xs font-medium text-primary"
              >
                {t("DashboardEarn.withdraw.useMax")}
              </button>
            }
          />
          {!payoutBlocked ? (
            <p id="earn-withdraw-available" className="text-xs text-secondary">
              {t("DashboardEarn.withdraw.available", {
                amount: formatUsd(tokenAvailable),
                token: token.toUpperCase(),
              })}
            </p>
          ) : null}
          {amountInput && !amountValid ? (
            <p id="earn-withdraw-error" className="text-xs text-error" role="alert">
              {amountShapeValid
                ? t("DashboardEarn.withdraw.errorExceedsWithdrawable", {
                    token: token.toUpperCase(),
                  })
                : t("DashboardEarn.withdraw.errorAmountRequired")}
            </p>
          ) : null}
        </div>

        <div className="mt-4 space-y-2">
          <Label htmlFor="earn-withdraw-destination">
            {t("DashboardEarn.withdraw.destinationLabel")}
          </Label>
          <Input
            id="earn-withdraw-destination"
            placeholder={t("DashboardEarn.withdraw.destinationPlaceholder")}
            disabled={submitting}
            value={destinationInput}
            aria-invalid={Boolean(destinationInput && !destinationValid)}
            aria-describedby={
              destinationInput && !destinationValid ? "earn-withdraw-destination-error" : undefined
            }
            onChange={(event: ChangeEvent<HTMLInputElement>) =>
              setDestinationInput(event.target.value)
            }
          />
          {destinationInput && !destinationValid ? (
            <p id="earn-withdraw-destination-error" className="text-xs text-error" role="alert">
              {t("DashboardEarn.withdraw.errorDestinationInvalid")}
            </p>
          ) : null}
        </div>

        <WithdrawPreviewPanel preview={preview} token={token} />

        {submitError ? (
          <p className="mt-4 text-xs text-error" role="alert">
            {submitError}
          </p>
        ) : null}

        <div className="mt-5 flex items-center justify-end gap-3">
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            {t("DashboardEarn.withdraw.cancel")}
          </Button>
          <Button
            onClick={submit}
            disabled={submitting || payoutBlocked || !amountValid || !destinationValid}
            iconLeft={submitting ? <Loader2Icon className="animate-spin" /> : undefined}
          >
            {submitting
              ? t("DashboardEarn.withdraw.confirming")
              : t("DashboardEarn.withdraw.confirm")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
