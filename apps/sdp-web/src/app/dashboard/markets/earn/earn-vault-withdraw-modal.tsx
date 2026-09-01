"use client";

import {
  CLUSTER_BY_SDP_ENVIRONMENT,
  type EarnVaultPosition,
  earnWithdrawSlippageFloor,
  type SdpEnvironment,
} from "@sdp/types";
import { ExternalLinkIcon, Loader2Icon } from "lucide-react";
import { type ChangeEvent, useEffect, useRef, useState } from "react";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { useLocale, useTranslations } from "@/i18n/provider";
import { explorerTxUrl } from "@/lib/explorer";
import { useModalFocus } from "@/lib/use-modal-focus";
import { compareUnsignedDecimals, parseUnsignedDecimal } from "./earn-decimal";
import { formatTokenQuantity } from "./earn-format";
import {
  applyIdempotencyKeyOutcome,
  resolveHeldIdempotencyKey,
} from "./earn-idempotency-key-store";
import {
  earnMintAsset,
  formatProviderAmount,
  shortenMarketAddress,
} from "./earn-market-presentation";
import {
  createEarnVaultWithdrawal,
  type EarnVaultWithdrawal,
  type EarnVaultWithdrawalPreview,
  fetchEarnVaultWithdrawalPreview,
  fetchEarnVaultWithdrawalsByRequestId,
  useEarnVaultWithdrawalOutcome,
} from "./earn-program-data";
import {
  floorForTolerance,
  isSlippageExceededRefusal,
  isZeroQuote,
  parseSlippageToleranceBps,
  quoteForKey,
  useDebouncedVaultQuote,
  type VaultQuoteState,
} from "./earn-vault-slippage";
import { VaultSlippageSection } from "./earn-vault-slippage-section";
import {
  forgetVaultWithdrawalFloor,
  recallVaultWithdrawalFloor,
  rememberVaultWithdrawalFloor,
  vaultWithdrawalIdempotencyKeyStore,
  vaultWithdrawalRequestFingerprint,
} from "./earn-vault-withdraw-tracking";

const MAX_SHARES_LENGTH = 128;

type VaultWithdrawalSharesValidation =
  | { kind: "valid"; canonicalShares: string }
  | { kind: "invalid" };

/**
 * Validate a share quantity without converting it through a JavaScript number.
 * The share mint's scale is not knowable client-side (share mints are not in
 * the well-known token table), so scale is the BUILDER's check: the API
 * answers over-precision with a readable 400 before anything is signed.
 */
function validateVaultWithdrawalShares(value: string): VaultWithdrawalSharesValidation {
  const shares = parseUnsignedDecimal(value, { maxLength: MAX_SHARES_LENGTH });
  if (!shares || compareUnsignedDecimals(shares.canonical, "0") !== 1) {
    return { kind: "invalid" };
  }
  return { kind: "valid", canonicalShares: shares.canonical };
}

/** The floor the current quote and tolerance imply, or `undefined` while they cannot. */
function derivedMinAmountOut(
  toleranceBps: number | null,
  quote: VaultQuoteState<EarnVaultWithdrawalPreview>
): string | undefined {
  if (toleranceBps === null || quote.kind !== "quoted") return undefined;
  if (quote.preview.blockingIssues.length > 0) return undefined;
  // `null` — a zero-asset quote — has no satisfiable floor; blocking the
  // submission is the only honest answer (see `floorForTolerance`).
  return (
    floorForTolerance(quote.preview.assetsOut, quote.preview.assetDecimals, toleranceBps) ??
    undefined
  );
}

/** Quote-state notices under the summary: loading, unavailable, or blocked. */
function WithdrawalQuoteNotices({ quote }: { quote: VaultQuoteState<EarnVaultWithdrawalPreview> }) {
  const t = useTranslations();
  if (quote.kind === "loading") {
    return (
      <p className="mt-2 text-xs text-tertiary" role="status">
        {t("DashboardEarn.vaultWithdraw.quoteLoading")}
      </p>
    );
  }
  if (quote.kind === "unavailable") {
    return (
      <p className="mt-2 text-xs text-error" role="alert">
        {t("DashboardEarn.vaultWithdraw.quoteUnavailable")}
      </p>
    );
  }
  const blockingIssue = quote.kind === "quoted" ? quote.preview.blockingIssues[0] : undefined;
  if (blockingIssue) {
    return (
      <p className="mt-2 text-xs text-error" role="alert">
        {t("DashboardEarn.vaultWithdraw.quoteBlocked", { message: blockingIssue.message })}
      </p>
    );
  }
  if (
    quote.kind === "quoted" &&
    isZeroQuote(quote.preview.assetsOut, quote.preview.assetDecimals)
  ) {
    return (
      <p className="mt-2 text-xs text-error" role="alert">
        {t("DashboardEarn.vaultWithdraw.quoteZeroAssets")}
      </p>
    );
  }
  return null;
}

function sharesBalanceHint(
  t: ReturnType<typeof useTranslations>,
  locale: string,
  totalShares: string | undefined,
  withdrawableShares: string | undefined,
  hasStakedShares: boolean
): string {
  if (withdrawableShares === undefined) {
    return totalShares === undefined
      ? t("DashboardEarn.vaultWithdraw.sharesUnknown")
      : t("DashboardEarn.vaultWithdraw.withdrawableUnknown", {
          shares: formatProviderAmount(totalShares, locale),
        });
  }
  if (hasStakedShares && totalShares !== undefined) {
    return t("DashboardEarn.vaultWithdraw.sharesAvailable", {
      available: formatProviderAmount(withdrawableShares, locale),
      total: formatProviderAmount(totalShares, locale),
    });
  }
  return t("DashboardEarn.vaultWithdraw.sharesHeld", {
    shares: formatProviderAmount(withdrawableShares, locale),
  });
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
  | { kind: "error"; message: string; slippageExceeded?: true }
  | { kind: "outcome"; outcome: WithdrawalOutcome; withdrawn?: EarnVaultWithdrawal };

function resolveWithdrawalSubmission(
  result: Awaited<ReturnType<typeof createEarnVaultWithdrawal>>,
  fallbackError: string,
  keyWasHeld: boolean,
  slippageExceededMessage: string
): WithdrawalSubmissionResolution {
  if (!result.ok) {
    if (isSlippageExceededRefusal(result.body)) {
      return { kind: "error", message: slippageExceededMessage, slippageExceeded: true };
    }
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

function TransactionLink({
  signature,
  environment,
}: {
  signature: string;
  environment: SdpEnvironment;
}) {
  const cluster = CLUSTER_BY_SDP_ENVIRONMENT[environment];

  return (
    <a
      className="inline-flex items-center gap-1 text-secondary underline decoration-border-strong underline-offset-4 transition-colors hover:text-primary"
      href={explorerTxUrl(signature, cluster)}
      rel="noreferrer"
      target="_blank"
    >
      {shortenMarketAddress(signature)}
      <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
    </a>
  );
}

function WithdrawalResult({
  outcome,
  environment,
  onClose,
  position,
}: {
  outcome: WithdrawalOutcome;
  environment: SdpEnvironment;
  onClose: () => void;
  position: EarnVaultPosition;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const asset = earnMintAsset(position.tokenMint);
  const positionName = position.label || shortenMarketAddress(position.providerReference);

  if (outcome.kind === "approval_pending") {
    return (
      <>
        <div className="flex items-center gap-2 pr-8">
          <h2
            className="text-base font-medium text-primary outline-none"
            data-modal-focus-target
            tabIndex={-1}
          >
            {t("DashboardEarn.vaultWithdraw.approvalTitle")}
          </h2>
          <Badge variant="warning">{t("DashboardEarn.vaultWithdraw.approvalStatus")}</Badge>
        </div>
        <p className="mt-2 text-sm leading-5 text-secondary">
          {t("DashboardEarn.vaultWithdraw.approvalBody")}
        </p>
        {outcome.approvalRequestId || outcome.walletOperationId ? (
          <dl className="mt-5 grid gap-3 rounded-xl bg-fill-subtle px-4 py-3 text-sm">
            {outcome.approvalRequestId ? (
              <div className="flex items-start justify-between gap-5">
                <dt className="text-tertiary">{t("DashboardEarn.deposit.vaultApprovalRequest")}</dt>
                <dd className="max-w-64 break-all text-right text-primary">
                  {outcome.approvalRequestId}
                </dd>
              </div>
            ) : null}
            {outcome.walletOperationId ? (
              <div className="flex items-start justify-between gap-5">
                <dt className="text-tertiary">{t("DashboardEarn.withdraw.referenceLabel")}</dt>
                <dd className="max-w-64 break-all text-right text-primary">
                  {outcome.walletOperationId}
                </dd>
              </div>
            ) : null}
          </dl>
        ) : null}
        <div className="mt-5 flex justify-end">
          <Button onClick={onClose}>{t("DashboardEarn.withdraw.done")}</Button>
        </div>
      </>
    );
  }

  const { withdrawal } = outcome;
  const copy: {
    body: string;
    note: string;
    status: string;
    statusVariant: BadgeVariant;
    title: string;
  } = outcome.absorbedByApproval
    ? {
        title: t("DashboardEarn.vaultWithdraw.absorbedTitle"),
        body: t("DashboardEarn.vaultWithdraw.absorbedBody"),
        note: t("DashboardEarn.vaultWithdraw.absorbedNote"),
        status: t("DashboardEarn.vaultWithdraw.absorbedStatus"),
        statusVariant: "info",
      }
    : withdrawal.status === "requested"
      ? {
          title: t("DashboardEarn.vaultWithdraw.recordedTitle"),
          body: t("DashboardEarn.vaultWithdraw.recordedBody"),
          note: t("DashboardEarn.vaultWithdraw.recordedNote"),
          status: t("DashboardEarn.vaultWithdraw.recordedStatus"),
          statusVariant: "warning",
        }
      : withdrawal.status === "confirmed"
        ? {
            title: t("DashboardEarn.vaultWithdraw.confirmedTitle"),
            body: t("DashboardEarn.vaultWithdraw.confirmedBody"),
            note: t("DashboardEarn.vaultWithdraw.settlingNote"),
            status: t("DashboardEarn.vaultWithdraw.confirmedStatus"),
            statusVariant: "warning",
          }
        : withdrawal.status === "finalized"
          ? {
              title: t("DashboardEarn.vaultWithdraw.finalizedTitle"),
              body: t("DashboardEarn.vaultWithdraw.finalizedBody"),
              note: t("DashboardEarn.vaultWithdraw.finalizedNote"),
              status: t("DashboardEarn.vaultWithdraw.finalizedStatus"),
              statusVariant: "success",
            }
          : {
              title: t("DashboardEarn.vaultWithdraw.submittedTitle"),
              body: t("DashboardEarn.vaultWithdraw.submittedBody"),
              note: t("DashboardEarn.vaultWithdraw.settlingNote"),
              status: t("DashboardEarn.vaultWithdraw.submittedStatus"),
              statusVariant: "default",
            };

  return (
    <>
      <div className="flex items-center gap-2 pr-8">
        <h2
          className="text-base font-medium text-primary outline-none"
          data-modal-focus-target
          tabIndex={-1}
        >
          {copy.title}
        </h2>
        <Badge variant={copy.statusVariant}>{copy.status}</Badge>
      </div>
      <p className="mt-2 text-sm leading-5 text-secondary">{copy.body}</p>

      <dl className="mt-5 grid gap-3 rounded-xl bg-fill-subtle px-4 py-3 text-sm">
        <div className="flex items-baseline justify-between gap-5">
          <dt className="text-tertiary">{t("DashboardEarn.deposit.vaultStrategy")}</dt>
          <dd className="max-w-64 text-right text-primary">{positionName}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-5">
          <dt className="text-tertiary">{t("DashboardEarn.vaultWithdraw.sharesLabel")}</dt>
          <dd className="text-right tabular-nums text-primary">
            {formatProviderAmount(withdrawal.shares, locale)}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-5">
          <dt className="text-tertiary">{t("DashboardEarn.vaultWithdraw.receiveAs")}</dt>
          <dd className="text-right text-primary">{asset.symbol}</dd>
        </div>
        {withdrawal.status === "requested" ? null : (
          <div className="flex items-baseline justify-between gap-5">
            <dt className="text-tertiary">{t("DashboardEarn.vaultWithdraw.transaction")}</dt>
            <dd className="text-right">
              <TransactionLink environment={environment} signature={withdrawal.signature} />
            </dd>
          </div>
        )}
      </dl>
      <p className="mt-4 text-xs leading-5 text-tertiary">{copy.note}</p>
      <div className="mt-5 flex justify-end">
        <Button onClick={onClose}>{t("DashboardEarn.withdraw.done")}</Button>
      </div>
    </>
  );
}

interface EarnVaultWithdrawalOutcomeTrackerProps {
  movementId: string;
  /** Keep the table's status badge current while the movement advances. */
  onUpdated?: (withdrawal: EarnVaultWithdrawal) => void;
  /** Refresh the balances the exit changed, then retire the tracker. */
  onSettled?: (withdrawal: EarnVaultWithdrawal) => void;
}

/**
 * Keeps one logical withdrawal under observation independently of the
 * dismissible modal. The canonical hook polls the movement until the
 * internal transaction reaches a terminal result.
 */
export function EarnVaultWithdrawalOutcomeTracker({
  movementId,
  onSettled,
  onUpdated,
}: EarnVaultWithdrawalOutcomeTrackerProps) {
  useEarnVaultWithdrawalOutcome(movementId, onSettled, onUpdated);
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
  // Declared per provider in @sdp/types: non-null means this provider REQUIRES
  // an explicit exit floor derived from a live quote. Null renders no slippage
  // control and sends no floor — Kamino's contract is unchanged.
  const slippagePolicy = earnWithdrawSlippageFloor(position.provider);
  const [slippageInput, setSlippageInput] = useState(() =>
    slippagePolicy ? String(slippagePolicy.defaultToleranceBps) : ""
  );
  const [slippageOpen, setSlippageOpen] = useState(false);
  const [quoteRefreshKey, setQuoteRefreshKey] = useState(0);
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
  const sharesValidation = validateVaultWithdrawalShares(sharesInput);
  const totalShares = position.shares;
  const withdrawableShares = position.withdrawableShares;
  const hasStakedShares =
    totalShares !== undefined &&
    withdrawableShares !== undefined &&
    compareUnsignedDecimals(totalShares, withdrawableShares) === 1;
  const overWithdrawableShares =
    sharesValidation.kind === "valid" && withdrawableShares !== undefined
      ? compareUnsignedDecimals(sharesValidation.canonicalShares, withdrawableShares) === 1
      : false;
  const sharesError =
    sharesInput.trim() === "" || sharesValidation.kind === "valid"
      ? null
      : t("DashboardEarn.vaultWithdraw.sharesInvalid");
  const slippageBps = slippagePolicy ? parseSlippageToleranceBps(slippageInput) : null;
  const slippageInvalid = slippagePolicy !== null && slippageBps === null;
  const quoteShares =
    slippagePolicy !== null && sharesValidation.kind === "valid"
      ? sharesValidation.canonicalShares
      : null;
  // The key serializes EVERY quote input, per the hook's contract: shares
  // alone would keep serving the previous position's quote across a swap.
  const quoteKey = quoteShares === null ? null : JSON.stringify([position.id, quoteShares]);
  const rawQuote = useDebouncedVaultQuote<EarnVaultWithdrawalPreview>(
    quoteKey,
    (signal) =>
      fetchEarnVaultWithdrawalPreview(
        { positionId: position.id, shares: quoteShares ?? "" },
        signal
      ),
    quoteRefreshKey
  );
  const quote = quoteForKey(rawQuote, quoteKey);
  const minAmountOut = derivedMinAmountOut(slippageBps, quote);
  const submitBlocked =
    sharesValidation.kind !== "valid" || (slippagePolicy !== null && minAmountOut === undefined);

  async function submitResolvedIntent(controller: AbortController, shares: string) {
    const fingerprint = vaultWithdrawalRequestFingerprint({
      projectId,
      positionId: position.id,
      shares,
      toleranceBps: slippagePolicy === null ? null : slippageBps,
    });
    const resolvedKey = await resolveHeldIdempotencyKey(
      vaultWithdrawalIdempotencyKeyStore,
      fingerprint,
      controller.signal,
      fetchEarnVaultWithdrawalsByRequestId
    );
    if (resolvedKey.kind === "aborted") return;
    if (resolvedKey.kind === "unavailable") {
      setSubmitError(t("DashboardEarn.vaultWithdraw.heldKeyUnavailable"));
      return;
    }

    // A HELD key must replay the floor it was MINTED with, verbatim — the
    // deposit modal documents why. A fresh key takes the freshly derived
    // floor, and records it for exactly that future replay.
    const heldFloor = resolvedKey.wasHeld ? recallVaultWithdrawalFloor(fingerprint) : undefined;
    const floorForRequest = heldFloor !== undefined ? heldFloor : (minAmountOut ?? null);
    rememberVaultWithdrawalFloor(fingerprint, floorForRequest);

    // No abort signal on the value-moving POST — see the deposit modal.
    const result = await createEarnVaultWithdrawal(
      {
        positionId: position.id,
        shares,
        ...(floorForRequest === null ? {} : { minAmountOut: floorForRequest }),
      },
      resolvedKey.key
    );
    // Key bookkeeping FIRST and unconditionally: the store outlives the
    // component, so an unmount mid-flight must not skip recording the answer.
    const disposition = applyIdempotencyKeyOutcome(
      vaultWithdrawalIdempotencyKeyStore,
      fingerprint,
      result
    );
    // A retired key can never be replayed, so its remembered floor is dead
    // weight the next fresh derivation must not inherit.
    if (disposition === "retired") forgetVaultWithdrawalFloor(fingerprint);
    if (controller.signal.aborted) return;
    const resolution = resolveWithdrawalSubmission(
      result,
      t("DashboardEarn.vaultWithdraw.submitError"),
      resolvedKey.wasHeld,
      // A blown floor gets THIS surface's own words and the control that
      // fixes it, not a relayed simulation log.
      t("DashboardEarn.vaultWithdraw.slippageExceeded")
    );
    if (resolution.kind === "error") {
      if (resolution.slippageExceeded) {
        // Open the control that fixes it, and re-quote: the retry's floor
        // must come from the rate that refused.
        setSlippageOpen(true);
        setQuoteRefreshKey((key) => key + 1);
      }
      setSubmitError(resolution.message);
      return;
    }
    setOutcome(resolution.outcome);
    if (resolution.withdrawn) onWithdrawn?.(resolution.withdrawn);
  }

  async function submit() {
    if (submittingRef.current || submitBlocked || sharesValidation.kind !== "valid") return;

    const controller = new AbortController();
    requestControllerRef.current?.abort();
    requestControllerRef.current = controller;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);

    try {
      await submitResolvedIntent(controller, sharesValidation.canonicalShares);
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
      setSubmitting(false);
    }
  }

  const modalLabel = t("DashboardEarn.vaultWithdraw.title", {
    position: position.label || shortenMarketAddress(position.providerReference),
  });

  if (outcome) {
    return (
      <Modal isOpen ariaLabel={modalLabel} onClose={onClose} size="md">
        <div className="p-6" ref={contentRef}>
          <WithdrawalResult
            environment={environment}
            onClose={onClose}
            outcome={outcome}
            position={position}
          />
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
        <p className="mt-2 max-w-md text-sm leading-5 text-secondary">
          {t("DashboardEarn.vaultWithdraw.body", { token: asset.symbol })}
        </p>

        <div className="mt-5 flex flex-col gap-2">
          <div className="flex items-end justify-between gap-3">
            <Label htmlFor="earn-vault-withdraw-shares">
              {t("DashboardEarn.vaultWithdraw.sharesLabel")}
            </Label>
            <Button
              disabled={submitting || withdrawableShares === undefined}
              onClick={() => {
                if (withdrawableShares === undefined) return;
                setSharesInput(withdrawableShares);
                setSubmitError(null);
              }}
              size="sm"
              type="button"
              variant="ghost"
            >
              {t("DashboardEarn.vaultWithdraw.max")}
            </Button>
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
            {sharesBalanceHint(t, locale, totalShares, withdrawableShares, hasStakedShares)}
          </div>
          {sharesError ? (
            <p className="text-xs text-error" role="alert">
              {sharesError}
            </p>
          ) : null}
          {overWithdrawableShares ? (
            <p className="text-xs text-warning" role="status">
              {t("DashboardEarn.vaultWithdraw.overShares")}
            </p>
          ) : null}
        </div>

        <dl className="mt-5 grid gap-3 rounded-xl bg-fill-subtle px-4 py-3 text-sm">
          <div className="flex items-baseline justify-between gap-5">
            <dt className="text-tertiary">{t("DashboardEarn.vaultWithdraw.receiveAs")}</dt>
            <dd className="text-right text-primary">{asset.symbol}</dd>
          </div>
          {position.tokenValue !== undefined ? (
            <div className="flex items-baseline justify-between gap-5">
              <dt className="text-tertiary">{t("DashboardEarn.vaultWithdraw.positionValue")}</dt>
              <dd className="text-right tabular-nums text-primary">
                {formatTokenQuantity(position.tokenValue, locale, asset.symbol)}
              </dd>
            </div>
          ) : null}
          {quote.kind === "quoted" && quote.preview.blockingIssues.length === 0 ? (
            <div className="flex items-baseline justify-between gap-5">
              <dt className="text-tertiary">{t("DashboardEarn.vaultWithdraw.expectedAmount")}</dt>
              <dd className="text-right tabular-nums text-primary">
                {formatTokenQuantity(quote.preview.assetsOut, locale, asset.symbol)}
              </dd>
            </div>
          ) : null}
          {minAmountOut !== undefined ? (
            <div className="flex items-baseline justify-between gap-5">
              <dt className="text-tertiary">{t("DashboardEarn.vaultWithdraw.minAmount")}</dt>
              <dd className="text-right tabular-nums text-primary">
                {formatTokenQuantity(minAmountOut, locale, asset.symbol)}
              </dd>
            </div>
          ) : null}
        </dl>

        <WithdrawalQuoteNotices quote={quote} />

        {slippagePolicy ? (
          <VaultSlippageSection
            help={t("DashboardEarn.vaultWithdraw.slippageHelp")}
            idPrefix="earn-vault-withdraw"
            input={slippageInput}
            invalid={slippageInvalid}
            onChange={(value) => {
              setSlippageInput(value);
              setSubmitError(null);
            }}
            onToggle={() => setSlippageOpen((open) => !open)}
            open={slippageOpen}
            submitting={submitting}
            toleranceBps={slippageBps}
          />
        ) : null}

        <p className="mt-4 text-xs leading-5 text-tertiary" id="earn-vault-withdraw-note">
          {t("DashboardEarn.vaultWithdraw.confirmNote")}
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
            disabled={submitting || submitBlocked}
            iconLeft={
              submitting ? <Loader2Icon aria-hidden="true" className="animate-spin" /> : null
            }
            onClick={() => void submit()}
          >
            {submitting
              ? t("DashboardEarn.vaultWithdraw.submitting")
              : t("DashboardEarn.vaultWithdraw.submit")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
