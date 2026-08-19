"use client";

import { decimalScale } from "@sdp/solana/amount";
import {
  EARN_PORTFOLIO_TOKENS,
  type EarnPortfolioToken,
  type EarnPortfolioWithdrawal,
  type EarnPortfolioWithdrawalPreview,
  earnProgramSolanaPayoutTokens,
} from "@sdp/types";
import { Loader2Icon } from "lucide-react";
import { type ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { Select, SelectItem } from "@/components/ui/select";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import { useModalFocus } from "@/lib/use-modal-focus";
import { compareUnsignedDecimals, parseUnsignedDecimal } from "./earn-decimal";
import { formatDurationRange, formatUsd, isoDurationDays } from "./earn-format";
import {
  createEarnWithdrawal,
  previewEarnWithdrawal,
  useEarnWithdrawalOutcomeToast,
} from "./earn-program-data";

/**
 * Exact ordering for provider money decimals. JavaScript numbers cannot
 * distinguish every six-decimal value once balances exceed 2^53, while the
 * API deliberately carries these amounts as strings.
 */
export const compareUsdDecimals = compareUnsignedDecimals;

export function isPositiveUsdAmount(value: string): boolean {
  const amount = parseUnsignedDecimal(value, { trim: false });
  return (
    amount !== undefined &&
    decimalScale(value) <= 6 &&
    compareUnsignedDecimals(amount.canonical, "0") === 1
  );
}

export function withdrawalRequestSignature(
  programId: string,
  amountUsd: string,
  /** Absent until a payout lane exists; no submit is reachable before then. */
  token: EarnPortfolioToken | undefined,
  destinationAddress: string
): string {
  return JSON.stringify([programId, amountUsd, token, destinationAddress]);
}

/** Base58 Solana address shape; the API re-validates with a real decoder. */
const SOLANA_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const PREVIEW_DEBOUNCE_MS = 400;

const WITHDRAWAL_STATUS_BADGES = {
  processing: { variant: "warning", key: "DashboardEarn.withdraw.statusProcessing" },
  pending_approval: { variant: "warning", key: "DashboardEarn.withdraw.statusPendingApproval" },
  completed: { variant: "success", key: "DashboardEarn.withdraw.statusCompleted" },
  partially_completed: {
    variant: "warning",
    key: "DashboardEarn.withdraw.statusPartiallyCompleted",
  },
  failed: { variant: "danger", key: "DashboardEarn.withdraw.statusFailed" },
  cancelled: { variant: "danger", key: "DashboardEarn.withdraw.statusCancelled" },
} as const satisfies Record<
  EarnPortfolioWithdrawal["status"],
  { variant: "success" | "warning" | "danger"; key: MessageKey }
>;

const WITHDRAWAL_STATUS_DESCRIPTIONS = {
  processing: "DashboardEarn.withdraw.createdDescription",
  // SDP does not expose Ground's customer-approval actions yet. Say where the
  // withdrawal is parked and prevent an unsafe duplicate submission.
  pending_approval: "DashboardEarn.withdraw.pendingApprovalDescription",
  completed: "DashboardEarn.overview.withdrawalCompleted",
  partially_completed: "DashboardEarn.overview.withdrawalPartiallyCompleted",
  failed: "DashboardEarn.overview.withdrawalFailed",
  cancelled: "DashboardEarn.overview.withdrawalCancelled",
} as const satisfies Record<EarnPortfolioWithdrawal["status"], MessageKey>;

type PreviewState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ready"; preview: EarnPortfolioWithdrawalPreview }
  | { phase: "error"; laneCeilingUsd?: string };

/**
 * What the SELECTED lane can actually pay out right now, straight from the
 * provider.
 *
 * This replaces a client-side estimate (`withdrawLanes()`, deleted with
 * PRO-1675) that joined position values to the catalogue and folded every
 * unattributable slice into each lane's ceiling. It could offer a `Max` the
 * provider then refused with a 409 — which reads as an SDP bug because, from
 * the customer's seat, it is one: we put a number on screen and a button that
 * fills it, and the withdrawal bounced.
 *
 * `error` is deliberately NOT a blocker. A failed READ must never trap an exit
 * (ADR 0002, money out beats money off), so an unresolved ceiling drops amount
 * validation back to shape-only and lets the provider be the authority it
 * always was. What it must never do is invent a number to put in its place.
 */
type LaneLiquidity =
  | { phase: "loading" }
  | { phase: "ready"; withdrawableUsd: string }
  | { phase: "error" };

/**
 * Precedence rule for the two writers of the lane ceiling: a response may write
 * only if no LATER-dispatched response already has.
 *
 * `lastWrittenSeq` is the last sequence that actually wrote — not the last
 * dispatched — and the difference is the whole point. A later response carrying
 * no liquidity information (a network failure, or a 409 with no balance) simply
 * does not write, so it must not veto an earlier response that does have a
 * figure; comparing against the last DISPATCH would strand the available line
 * on "checking…" whenever the second request came back empty.
 */
export function liquidityWriteWins(seq: number, lastWrittenSeq: number): boolean {
  return seq >= lastWrittenSeq;
}

/**
 * The reported ceiling floored to whole cents, as an exact decimal string.
 *
 * `withdrawableUsd` is a BALANCE, not a fillable amount — verified against
 * Ground sandbox 2026-08-13, where a lane reporting `20.001241` answers 200 for
 * `20.00` and 409 for `20.001241` itself. Filling Max with the raw figure
 * therefore recreates the very "Max that the provider refuses" this ticket set
 * out to remove, just one layer deeper.
 *
 * Flooring to cents is also what makes the modal self-consistent: the available
 * line renders `$20.00`, so Max should put exactly that in the box. The
 * abandoned remainder is sub-cent dust, and nothing traps it — validation still
 * accepts the full reported figure if a reader types it (see `amountValid`), so
 * this narrows what SDP OFFERS, never what it permits.
 *
 * String arithmetic, not `Math.floor(Number(x) * 100) / 100`: these are money
 * decimals the provider re-parses, and binary floats round the wrong way.
 */
export function floorUsdToCents(decimal: string): string {
  const [whole = "0", fraction = ""] = decimal.trim().split(".");
  return `${whole}.${fraction.padEnd(2, "0").slice(0, 2)}`;
}

/**
 * The lane ceiling a provider names when it refuses an over-request.
 *
 * Ground answers `409 insufficient_funds` with the destination lane's balance
 * breakdown, which the provider client normalizes onto `error.details.balance`
 * (PRO-1675). Reading it lets SDP say how short the request was instead of
 * echoing wire text. Defensive throughout: this is an error path, and copy that
 * names no number is still better than a crash while a reader is trying to
 * move money.
 */
export function laneCeilingFromErrorBody(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== "object") return undefined;
  const details = (error as { details?: unknown }).details;
  if (!details || typeof details !== "object") return undefined;
  const balance = (details as { balance?: unknown }).balance;
  if (!balance || typeof balance !== "object") return undefined;
  const withdrawableUsd = (balance as { withdrawableUsd?: unknown }).withdrawableUsd;
  return typeof withdrawableUsd === "string" && parseUnsignedDecimal(withdrawableUsd)
    ? withdrawableUsd.trim()
    : undefined;
}

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

/**
 * The liquidity line: label left, provider figure right, aligned with the
 * amount input above it.
 *
 * This is where the authoritative number lives — deliberately NOT also in the
 * preview panel below, which would restate it 40px away. The panel stays the
 * amount-specific detail (fee, resulting portfolio, processing window).
 */
function LaneAvailableLine({
  liquidity,
  token,
}: {
  liquidity: LaneLiquidity;
  token: EarnPortfolioToken;
}) {
  const t = useTranslations();
  const locale = useLocale();
  return (
    <>
      <div id="earn-withdraw-available" className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-secondary">
          {t("DashboardEarn.withdraw.availableLabel", { token: token.toUpperCase() })}
        </span>
        {liquidity.phase === "ready" ? (
          <span className="text-xs font-medium tabular-nums text-primary">
            {formatUsd(liquidity.withdrawableUsd, locale)}
          </span>
        ) : (
          <span className="text-xs tabular-nums text-tertiary">
            {liquidity.phase === "loading" ? t("DashboardEarn.withdraw.availableChecking") : "—"}
          </span>
        )}
      </div>
      {liquidity.phase === "error" ? (
        // Not an alert: nothing is wrong with what the reader did, and the
        // withdrawal can still proceed — the provider decides at confirm.
        <p className="text-xs text-tertiary">{t("DashboardEarn.withdraw.availableUnavailable")}</p>
      ) : null}
    </>
  );
}

/**
 * Why the typed amount is refused. Names the real lane ceiling whenever the
 * provider has told us one, so the reader gets an answer rather than advice.
 */
function AmountError({
  formatValid,
  laneCeiling,
  token,
}: {
  formatValid: boolean;
  laneCeiling: string | undefined;
  token: EarnPortfolioToken;
}) {
  const t = useTranslations();
  const locale = useLocale();
  if (!formatValid) {
    return (
      <p id="earn-withdraw-error" className="text-xs text-error" role="alert">
        {t("DashboardEarn.withdraw.errorAmountRequired")}
      </p>
    );
  }
  return (
    <p id="earn-withdraw-error" className="text-xs text-error" role="alert">
      {laneCeiling === undefined
        ? t("DashboardEarn.withdraw.errorExceedsWithdrawable", { token: token.toUpperCase() })
        : t("DashboardEarn.withdraw.errorExceedsCeiling", {
            token: token.toUpperCase(),
            amount: formatUsd(laneCeiling, locale),
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
  const locale = useLocale();
  if (preview.phase === "idle") return null;
  return (
    <div className="mt-4 rounded-md border border-border-default bg-fill-subtle p-3">
      <p className="text-xs font-medium text-primary">{t("DashboardEarn.withdraw.previewTitle")}</p>
      {preview.phase === "loading" ? (
        <p className="mt-1 text-xs text-secondary">{t("DashboardEarn.withdraw.previewLoading")}</p>
      ) : null}
      {preview.phase === "error" ? (
        // Translated, never the provider's wire text. Only Solana-payable
        // tokens are offered at all, so the one user-explainable failure
        // left is lane funds; the preview stays the authority on the lane.
        // When the refusal carried the lane's real ceiling, SAY it — "try a
        // smaller amount" is advice, "$412.50 is available" is an answer.
        <p className="mt-1 text-xs text-error" role="alert">
          {preview.laneCeilingUsd === undefined
            ? t("DashboardEarn.withdraw.previewInsufficient", { token: token.toUpperCase() })
            : t("DashboardEarn.withdraw.previewInsufficientCeiling", {
                token: token.toUpperCase(),
                amount: formatUsd(preview.laneCeilingUsd, locale),
              })}
        </p>
      ) : null}
      {preview.phase === "ready" ? (
        <>
          <dl className="mt-1 text-xs">
            <div className="flex items-baseline justify-between gap-4 py-1">
              <dt className="text-tertiary">{t("DashboardEarn.withdraw.previewFee")}</dt>
              <dd className="text-primary tabular-nums">
                {formatUsd(preview.preview.feeUsd, locale)}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-4 py-1">
              <dt className="text-tertiary">{t("DashboardEarn.withdraw.previewTotalAfter")}</dt>
              <dd className="text-primary tabular-nums">
                {formatUsd(preview.preview.totalUsdAfterWithdrawal, locale)}
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
  const locale = useLocale();
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
        {t(WITHDRAWAL_STATUS_DESCRIPTIONS[withdrawal.status])}
      </p>

      <dl className="mt-4 rounded-md border border-border-default bg-fill-subtle p-3 text-xs">
        <div className="flex items-baseline justify-between gap-4 py-1">
          <dt className="text-tertiary">{t("DashboardEarn.withdraw.amountLabel")}</dt>
          <dd className="text-primary tabular-nums">
            {formatUsd(withdrawal.amountRequestedUsd ?? fallbackAmountUsd, locale)} ·{" "}
            {token.toUpperCase()}
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
  /** The program the money leaves. One modal instance serves one program. */
  programId: string;
  /** Open provider id from the durable program read model. */
  provider: string;
  onClose: () => void;
  /**
   * Fired once a withdrawal is accepted, carrying the provider's ref so the
   * caller can refresh balances AND follow that withdrawal to its outcome —
   * the wallet returning to idle does not say whether the money arrived.
   */
  onWithdrawalCreated: (withdrawalRef: string) => void;
}

interface EarnWithdrawalOutcomeTrackerProps {
  programId: string;
  withdrawalRef: string;
  /** Refresh balances and retire the tracker after its terminal announcement. */
  onSettled?: () => void;
}

/**
 * Keeps provider-authoritative outcome polling alive independently of the
 * dismissible modal. Treasury mounts one tracker for the accepted withdrawal;
 * the canonical hook waits through `pending_approval`, announces exactly once
 * on a terminal withdrawal status, and then asks the caller to retire it.
 */
export function EarnWithdrawalOutcomeTracker({
  programId,
  withdrawalRef,
  onSettled,
}: EarnWithdrawalOutcomeTrackerProps) {
  useEarnWithdrawalOutcomeToast(programId, withdrawalRef, onSettled);
  return null;
}

/**
 * Withdrawal from ONE program's provider wallet: one USD amount + stablecoin +
 * Solana destination. A live preview (fees and the provider's typical
 * processing window) precedes confirmation; the accepted withdrawal stays on
 * screen in its processing state.
 */
export function EarnWithdrawModal({
  programId,
  provider,
  onClose,
  onWithdrawalCreated,
}: EarnWithdrawModalProps) {
  const t = useTranslations();
  const locale = useLocale();
  const contentRef = useModalFocus({
    focusKey: programId,
    initialFocusSelector: 'input:not([type="hidden"]):not([disabled])',
    fallbackAttribute: "data-earn-withdraw-focus-fallback",
    fallbackValue: programId,
    restoreTiming: "animation-frame",
  });
  const [amountInput, setAmountInput] = useState("");
  const withdrawTokenOptions = EARN_PORTFOLIO_TOKENS.filter((candidate) =>
    earnProgramSolanaPayoutTokens(provider).includes(candidate)
  );
  // `undefined` when the provider declares no Solana payout lane, and it stays
  // undefined — seeding a token the provider cannot pay out would make every
  // read below depend on remembering to fail closed. The form only renders once
  // this is a real lane, so nothing downstream handles a fabricated one.
  const [token, setToken] = useState<EarnPortfolioToken | undefined>(withdrawTokenOptions[0]);
  const [destinationInput, setDestinationInput] = useState("");
  const [preview, setPreview] = useState<PreviewState>({ phase: "idle" });
  const [laneLiquidity, setLaneLiquidity] = useState<LaneLiquidity>({ phase: "loading" });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [created, setCreated] = useState<{
    withdrawal: EarnPortfolioWithdrawal;
    token: EarnPortfolioToken;
  } | null>(null);

  // The provider's own ceiling for the selected lane, or `undefined` while it
  // is still being read (or if the read failed). Never a locally-derived
  // stand-in: an estimate here is what PRO-1675 removed.
  const laneCeiling =
    laneLiquidity.phase === "ready" && parseUnsignedDecimal(laneLiquidity.withdrawableUsd)
      ? laneLiquidity.withdrawableUsd
      : undefined;
  // What `Max` puts in the box: the offered amount is conservative (whole
  // cents, empirically fillable) while validation below stays permissive
  // against the full reported figure. Offer only what will work; forbid only
  // what certainly will not.
  const maxFillAmount =
    laneLiquidity.phase === "ready" ? floorUsdToCents(laneLiquidity.withdrawableUsd) : undefined;
  const amount = amountInput.trim();
  const amountFormatValid = isPositiveUsdAmount(amount);
  // An unresolved ceiling validates SHAPE only. Blocking the confirm because
  // our own read is slow or broken would gate an exit on provider
  // availability, which ADR 0002 forbids — the provider decides, as it always
  // did; we just no longer pretend to know the answer first.
  const amountValid =
    token !== undefined &&
    amountFormatValid &&
    (laneCeiling === undefined || compareUsdDecimals(amount, laneCeiling) !== 1);
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
   *
   * `programId` is part of the signature because one modal instance can be
   * re-pointed at another program without unmounting. Without it, a key minted
   * for a withdrawal from program A would be carried into an identical-looking
   * withdrawal from program B.
   */
  const requestSignature = withdrawalRequestSignature(programId, amount, token, destination);
  const requestRef = useRef<{ signature: string; id: string } | null>(null);
  if (requestRef.current?.signature !== requestSignature) {
    requestRef.current = { signature: requestSignature, id: crypto.randomUUID() };
  }
  const requestId = requestRef.current.id;

  useEffect(() => {
    if (submitting) contentRef.current?.focus();
  }, [submitting, contentRef]);

  /**
   * Order the two writers of `laneLiquidity`.
   *
   * BOTH previews report the lane's `withdrawableUsd`, and they race: the
   * on-open liquidity read is undebounced while the amount-specific one waits
   * out `PREVIEW_DEBOUNCE_MS`. A reader who types immediately can therefore have
   * the FIRST request land second — and Ground takes ~500ms on this endpoint, so
   * that ordering is real, not theoretical. Left alone, a stale response
   * overwrites a fresh ceiling and `Max` goes back to offering an amount the
   * provider refuses, or validation rejects an amount that is currently fine.
   * Each effect's `AbortController` cannot help: it only cancels its OWN
   * request, and these are two independent effects.
   *
   * Precedence is by DISPATCH order, not arrival. The ref tracks the last
   * sequence that actually WROTE, not the last dispatched — deliberately: a
   * later response carrying no liquidity information must not veto an earlier
   * one that has some, which would strand the line on "checking…" forever.
   */
  const dispatchSeqRef = useRef(0);
  const liquidityWriteSeqRef = useRef(0);
  const commitLaneLiquidity = useCallback((seq: number, next: LaneLiquidity) => {
    if (!liquidityWriteWins(seq, liquidityWriteSeqRef.current)) return;
    liquidityWriteSeqRef.current = seq;
    setLaneLiquidity(next);
  }, []);

  /**
   * The liquidity read: one AMOUNT-LESS preview per (program, token), fired on
   * open rather than on the keystroke path.
   *
   * "How much can I get out right now?" is the first question a reader has, and
   * until PRO-1675 nothing asked the provider it until an amount had already
   * been typed and locally judged valid. Undebounced on purpose — there is no
   * input to settle — and deliberately NOT folded into the programs list, which
   * is already 2N provider round trips against an account every org shares.
   */
  useEffect(() => {
    if (token === undefined || created) {
      // No declared payout lane means there is no ceiling to read, and the
      // available line must say so rather than sit on "checking…" forever.
      if (token === undefined) setLaneLiquidity({ phase: "error" });
      return;
    }
    const controller = new AbortController();
    // A fresh dispatch, so `loading` legitimately outranks anything older still
    // in flight — the token just changed and no stale response may un-blank it.
    const seq = ++dispatchSeqRef.current;
    commitLaneLiquidity(seq, { phase: "loading" });
    void (async () => {
      const result = await previewEarnWithdrawal(programId, { token }, controller.signal);
      if (controller.signal.aborted) return;
      if (result.ok) {
        commitLaneLiquidity(seq, {
          phase: "ready",
          withdrawableUsd: result.data.data.preview.withdrawableUsd,
        });
        return;
      }
      // A REFUSAL can still answer the question. Verified against Ground
      // sandbox 2026-08-13: the amount-less preview may come back 409 while
      // carrying the lane's balance breakdown — so the number we asked for
      // arrives on the error path. Treating that as "unknown" would discard
      // the very payload PRO-1675 exists to stop discarding.
      const laneCeilingUsd = laneCeilingFromErrorBody(result.body);
      commitLaneLiquidity(
        seq,
        laneCeilingUsd === undefined
          ? { phase: "error" }
          : { phase: "ready", withdrawableUsd: laneCeilingUsd }
      );
    })();
    return () => controller.abort();
  }, [programId, token, created, commitLaneLiquidity]);

  // The amount-specific preview — fee, resulting portfolio, processing window —
  // which needs only amount + token, so it refreshes as those settle. Every
  // response also carries a fresher `withdrawableUsd` than the on-open read, so
  // both calls feed the one ceiling the modal quotes.
  useEffect(() => {
    if (token === undefined || !amountValid || created) {
      setPreview({ phase: "idle" });
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setPreview({ phase: "loading" });
      // Sequenced at REQUEST time, not at effect time: the debounce means this
      // dispatch is genuinely later than the on-open read it may overtake.
      const seq = ++dispatchSeqRef.current;
      const result = await previewEarnWithdrawal(
        programId,
        { amountUsd: amount, token },
        controller.signal
      );
      if (controller.signal.aborted) return;
      if (result.ok) {
        setPreview({ phase: "ready", preview: result.data.data.preview });
        commitLaneLiquidity(seq, {
          phase: "ready",
          withdrawableUsd: result.data.data.preview.withdrawableUsd,
        });
        return;
      }
      // A refusal that names the lane's real ceiling teaches us the number the
      // on-open read could not, so adopt it: the available line and `Max`
      // correct themselves instead of standing by a figure just proven wrong.
      const laneCeilingUsd = laneCeilingFromErrorBody(result.body);
      setPreview({ phase: "error", ...(laneCeilingUsd !== undefined && { laneCeilingUsd }) });
      if (laneCeilingUsd !== undefined) {
        commitLaneLiquidity(seq, { phase: "ready", withdrawableUsd: laneCeilingUsd });
      }
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [amount, amountValid, token, created, programId, commitLaneLiquidity]);

  const submit = async () => {
    if (token === undefined || !amountValid || !destinationValid || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    const result = await createEarnWithdrawal(programId, {
      requestId,
      amountUsd: amount,
      token,
      destinationAddress: destination,
    });
    setSubmitting(false);
    if (!result.ok) {
      // A create can still lose a race with a rebalance between preview and
      // confirm. When the refusal names the lane ceiling, answer with SDP copy
      // carrying that number and correct the available line — echoing the
      // provider's own string at the moment a payout bounced is the worst copy
      // in the flow.
      const laneCeilingUsd = laneCeilingFromErrorBody(result.body);
      if (laneCeilingUsd === undefined) {
        setSubmitError(result.error);
        return;
      }
      // Sequenced last on purpose: a refusal of a real payout attempt is the
      // most authoritative liquidity signal there is, so no preview still in
      // flight may overwrite it.
      commitLaneLiquidity(++dispatchSeqRef.current, {
        phase: "ready",
        withdrawableUsd: laneCeilingUsd,
      });
      setSubmitError(
        t("DashboardEarn.withdraw.previewInsufficientCeiling", {
          token: token.toUpperCase(),
          amount: formatUsd(laneCeilingUsd, locale),
        })
      );
      return;
    }
    setCreated({ withdrawal: result.data.data.withdrawal, token });
    onWithdrawalCreated(result.data.data.withdrawal.withdrawalRef);
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
            withdrawal={created.withdrawal}
            fallbackAmountUsd={amount}
            token={created.token}
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

        {token === undefined ? (
          <p className="mt-4 text-sm leading-5 text-secondary" role="status">
            {t("DashboardEarn.withdraw.providerUnavailable")}
          </p>
        ) : (
          <>
            {/* Token FIRST: it scopes everything below — the available figure is
              read per lane, so changing this re-asks the provider. Options carry
              no amount of their own: a figure beside an UNSELECTED lane would
              cost one preview call per option against a provider account every
              org shares, and the estimate that used to fill them is exactly what
              this flow stopped quoting (PRO-1675). */}
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
                {withdrawTokenOptions.map((candidate) => (
                  <SelectItem key={candidate} value={candidate}>
                    {candidate.toUpperCase()}
                  </SelectItem>
                ))}
              </Select>
            </div>

            <div className="mt-4 space-y-2">
              <Label htmlFor="earn-withdraw-amount">
                {t("DashboardEarn.withdraw.amountLabel")}
              </Label>
              <Input
                size="lg"
                id="earn-withdraw-amount"
                inputMode="decimal"
                placeholder="0.00"
                disabled={submitting}
                value={amountInput}
                aria-invalid={Boolean(amountInput && !amountValid)}
                aria-describedby={
                  amountInput && !amountValid
                    ? "earn-withdraw-available earn-withdraw-error"
                    : "earn-withdraw-available"
                }
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  setAmountInput(event.target.value)
                }
                iconRight={
                  // Disabled until the ceiling resolves: a Max with nothing
                  // authoritative behind it is the exact affordance this removed.
                  <button
                    type="button"
                    disabled={
                      submitting ||
                      maxFillAmount === undefined ||
                      compareUsdDecimals(maxFillAmount, "0") !== 1
                    }
                    onClick={() => {
                      if (maxFillAmount !== undefined) setAmountInput(maxFillAmount);
                    }}
                    className="pointer-events-auto text-xs font-medium text-primary disabled:text-tertiary"
                  >
                    {t("DashboardEarn.withdraw.useMax")}
                  </button>
                }
              />
              <LaneAvailableLine liquidity={laneLiquidity} token={token} />
              {amountInput && !amountValid ? (
                <AmountError
                  formatValid={amountFormatValid}
                  laneCeiling={laneCeiling}
                  token={token}
                />
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
                  destinationInput && !destinationValid
                    ? "earn-withdraw-destination-error"
                    : undefined
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
          </>
        )}

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
            disabled={submitting || !amountValid || !destinationValid}
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
