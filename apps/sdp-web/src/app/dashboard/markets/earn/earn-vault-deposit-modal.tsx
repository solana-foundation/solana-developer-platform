"use client";

import { decimalScale } from "@sdp/solana/amount";
import { type EarnStrategy, earnDepositSlippageFloor, WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types";
import { ExternalLinkIcon, Loader2Icon } from "lucide-react";
import { type ChangeEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { useLocale, useTranslations } from "@/i18n/provider";
import { explorerTxUrl } from "@/lib/explorer";
import { useModalFocus } from "@/lib/use-modal-focus";
import { cn } from "@/lib/utils";
import {
  type EarnFundingWallet,
  useEarnFundingWallets,
  walletDisplayName,
} from "./deposit/earn-funding-wallets";
import { compareUnsignedDecimals, parseUnsignedDecimal } from "./earn-decimal";
import { formatTokenQuantity, tokenSymbol } from "./earn-format";
import {
  applyIdempotencyKeyOutcome,
  resolveHeldIdempotencyKey,
} from "./earn-idempotency-key-store";
import { shortenMarketAddress } from "./earn-market-presentation";
import {
  createEarnVaultDeposit,
  type EarnVaultDeposit,
  type EarnVaultDepositPreview,
  fetchEarnVaultDepositByRequestId,
  fetchEarnVaultDepositPreview,
  useEarnVaultDepositOutcomeToast,
} from "./earn-program-data";
import { strategySourceLabel, strategyToken } from "./earn-program-presentation";
import {
  forgetVaultDepositFloor,
  recallVaultDepositFloor,
  rememberVaultDepositFloor,
  vaultDepositIdempotencyKeyStore,
  vaultDepositRequestFingerprint,
} from "./earn-vault-deposit-tracking";
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

const MAX_AMOUNT_LENGTH = 128;

export { compareUnsignedDecimals };

export type VaultDepositAmountValidation =
  | { kind: "valid"; canonicalAmount: string }
  | { kind: "invalid" }
  | { kind: "unknown_scale" }
  | { kind: "over_precision"; decimals: number };

/**
 * Validate a vault amount without converting it through a JavaScript number.
 * Trailing zeroes beyond the mint scale are harmless; any non-zero digit below
 * one mint atom is rejected rather than rounded before a value-moving request.
 */
export function validateVaultDepositAmount(
  value: string,
  decimals: number | undefined
): VaultDepositAmountValidation {
  const amount = parseUnsignedDecimal(value, { maxLength: MAX_AMOUNT_LENGTH });
  if (!amount || compareUnsignedDecimals(amount.canonical, "0") !== 1) {
    return { kind: "invalid" };
  }
  if (decimals === undefined) return { kind: "unknown_scale" };

  if (decimalScale(amount.canonical) > decimals) {
    return { kind: "over_precision", decimals };
  }

  return { kind: "valid", canonicalAmount: amount.canonical };
}

function atomsToDecimalString(atoms: bigint, decimals: number): string {
  if (decimals === 0) return atoms.toString();
  const padded = atoms.toString().padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * Exact balance for one mint. `undefined` means the RPC observation was absent
 * or malformed; a successful observation with no row for the mint is real zero.
 */
export function walletBalanceForMint(
  wallet: EarnFundingWallet,
  mint: string,
  decimals: number
): string | undefined {
  if (wallet.balances === undefined) return undefined;
  const balances = wallet.balances.filter((balance) => balance.mint === mint);
  if (balances.length === 0) return "0";

  let atoms = 0n;
  for (const balance of balances) {
    if (balance.decimals !== decimals || !/^\d+$/.test(balance.amount)) return undefined;
    atoms += BigInt(balance.amount);
  }
  return atomsToDecimalString(atoms, decimals);
}

/** The quote's own rows in the confirm summary: expected shares and the floor. */
function DepositQuoteSummaryRows({
  quote,
  minSharesOut,
}: {
  quote: VaultQuoteState<EarnVaultDepositPreview>;
  minSharesOut: string | undefined;
}) {
  const t = useTranslations();
  return (
    <>
      {quote.kind === "quoted" && quote.preview.blockingIssues.length === 0 ? (
        <div className="flex items-baseline justify-between gap-5 py-1">
          <dt className="text-tertiary">{t("DashboardEarn.deposit.vaultExpectedShares")}</dt>
          <dd className="text-right tabular-nums text-primary">{quote.preview.sharesOut}</dd>
        </div>
      ) : null}
      {minSharesOut !== undefined ? (
        <div className="flex items-baseline justify-between gap-5 py-1">
          <dt className="text-tertiary">{t("DashboardEarn.deposit.vaultMinShares")}</dt>
          <dd className="text-right tabular-nums text-primary">{minSharesOut}</dd>
        </div>
      ) : null}
    </>
  );
}

/** Quote-state notices under the summary: loading, unavailable, or blocked. */
function DepositQuoteNotices({ quote }: { quote: VaultQuoteState<EarnVaultDepositPreview> }) {
  const t = useTranslations();
  if (quote.kind === "loading") {
    return (
      <p className="mt-2 text-xs text-tertiary" role="status">
        {t("DashboardEarn.deposit.vaultQuoteLoading")}
      </p>
    );
  }
  if (quote.kind === "unavailable") {
    return (
      <p className="mt-2 text-xs text-error" role="alert">
        {t("DashboardEarn.deposit.vaultQuoteUnavailable")}
      </p>
    );
  }
  const blockingIssue = quote.kind === "quoted" ? quote.preview.blockingIssues[0] : undefined;
  if (blockingIssue) {
    return (
      <p className="mt-2 text-xs text-error" role="alert">
        {t("DashboardEarn.deposit.vaultQuoteBlocked", { message: blockingIssue.message })}
      </p>
    );
  }
  if (
    quote.kind === "quoted" &&
    isZeroQuote(quote.preview.sharesOut, quote.preview.shareDecimals)
  ) {
    return (
      <p className="mt-2 text-xs text-error" role="alert">
        {t("DashboardEarn.deposit.vaultQuoteZeroShares")}
      </p>
    );
  }
  return null;
}

/** The floor the current quote and tolerance imply, or `undefined` while they cannot. */
function derivedMinSharesOut(
  toleranceBps: number | null,
  quote: VaultQuoteState<EarnVaultDepositPreview>
): string | undefined {
  if (toleranceBps === null || quote.kind !== "quoted") return undefined;
  if (quote.preview.blockingIssues.length > 0) return undefined;
  // `null` — a zero-share quote — has no satisfiable floor; blocking the
  // submission is the only honest answer (see `floorForTolerance`).
  return (
    floorForTolerance(quote.preview.sharesOut, quote.preview.shareDecimals, toleranceBps) ??
    undefined
  );
}

type DepositOutcome =
  | {
      kind: "approval_pending";
      approvalRequestId?: string;
      walletOperationId?: string;
    }
  | {
      kind: "deposit";
      amount: string;
      deposit: EarnVaultDeposit;
      walletName: string;
      /**
       * The approval executor won the race: it executed this exact intent
       * between the held-key pre-flight and this POST, so the server absorbed
       * the submission as a replay of the approval's movement. Real money DID
       * move — once, via the approval — but THIS submission moved nothing, and
       * saying "deposit submitted" would leave the customer believing two
       * deposits happened, or none.
       */
      absorbedByApproval?: true;
    };

type DepositSubmissionResolution =
  | { kind: "error"; message: string; slippageExceeded?: true }
  | { kind: "outcome"; outcome: DepositOutcome; deposited?: EarnVaultDeposit };

function resolveDepositSubmission(
  result: Awaited<ReturnType<typeof createEarnVaultDeposit>>,
  amount: string,
  walletName: string,
  fallbackError: string,
  keyWasHeld: boolean,
  slippageExceededMessage: string
): DepositSubmissionResolution {
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

  const deposit = result.data.deposit;
  if (deposit.status === "failed") {
    return { kind: "error", message: deposit.failureReason || fallbackError };
  }
  // A replay of a HELD key can only be the approval's own execution: the key is
  // client-minted, so the executor replaying the original Idempotency-Key is
  // the sole other writer under it. The pre-flight said "absent", the answer
  // says "already recorded" — the approval landed in between, and no client
  // read could have closed that window. Announce what actually happened rather
  // than crediting this submission; the caller still refreshes and watches the
  // movement, because it is real and may still be settling. Deliberately NOT
  // retried with a fresh key: auto-resubmitting money after a race is the
  // double-deposit hazard, so making a second deposit stays a human decision.
  if (deposit.replayed && keyWasHeld) {
    return {
      kind: "outcome",
      outcome: { kind: "deposit", amount, deposit, walletName, absorbedByApproval: true },
      deposited: deposit,
    };
  }
  return {
    kind: "outcome",
    outcome: { kind: "deposit", amount, deposit, walletName },
    deposited: deposit,
  };
}

type Translation = ReturnType<typeof useTranslations>;

function amountValidationMessage(
  amountInput: string,
  validation: VaultDepositAmountValidation,
  t: Translation
): string | null {
  if (amountInput.trim() === "" || validation.kind === "valid") return null;
  if (validation.kind === "over_precision") {
    return t("DashboardEarn.deposit.vaultAmountPrecision", { decimals: validation.decimals });
  }
  if (validation.kind === "unknown_scale") {
    return t("DashboardEarn.deposit.strategyAssetUnavailable");
  }
  return t("DashboardEarn.withdraw.errorAmountRequired");
}

interface DepositWalletPickerProps {
  wallets: readonly EarnFundingWallet[] | undefined;
  walletsError: unknown;
  walletsLoading: boolean;
  selectedWalletId: string | null;
  depositMint: string | undefined;
  decimals: number | undefined;
  symbol: string;
  submitting: boolean;
  onSelect: (walletId: string) => void;
}

function DepositWalletPicker({
  wallets,
  walletsError,
  walletsLoading,
  selectedWalletId,
  depositMint,
  decimals,
  symbol,
  submitting,
  onSelect,
}: DepositWalletPickerProps) {
  const t = useTranslations();
  const locale = useLocale();

  let walletContent: ReactNode;
  if (walletsLoading && wallets === undefined) {
    walletContent = (
      <div className="flex items-center gap-2 rounded-lg border border-border-default p-4 text-sm text-secondary">
        <Loader2Icon aria-hidden="true" className="size-4 animate-spin" />
        {t("DashboardEarn.withdraw.availableChecking")}
      </div>
    );
  } else if (walletsError) {
    walletContent = (
      <p
        className="rounded-lg border border-destructive-border bg-destructive-bg p-4 text-sm text-error"
        role="alert"
      >
        {t("DashboardEarn.deposit.walletsLoadError")}
      </p>
    );
  } else if ((wallets?.length ?? 0) === 0) {
    walletContent = (
      <div className="rounded-lg border border-border-default bg-fill-subtle p-4">
        <p className="text-sm font-medium text-primary">
          {t("DashboardEarn.deposit.walletsEmptyTitle")}
        </p>
        <p className="mt-1 text-sm leading-5 text-secondary">
          {t("DashboardEarn.deposit.walletsEmptyBody")}
        </p>
        <Button asChild className="mt-3" size="sm" variant="outline">
          <a href="/dashboard/wallets">{t("DashboardEarn.deposit.goToWallets")}</a>
        </Button>
      </div>
    );
  } else {
    walletContent = wallets?.map((wallet) => {
      const executable = wallet.isRuntimeExecutionAllowed;
      const checked = executable && wallet.id === selectedWalletId;
      const balance =
        depositMint && decimals !== undefined
          ? walletBalanceForMint(wallet, depositMint, decimals)
          : undefined;
      return (
        <label
          aria-disabled={!executable}
          className={cn(
            "flex items-start gap-3 rounded-lg border p-4 transition-colors",
            executable ? "cursor-pointer" : "cursor-not-allowed opacity-60",
            checked
              ? "border-primary bg-fill-subtle"
              : executable
                ? "border-border-default hover:border-border-strong"
                : "border-border-default bg-fill-subtle"
          )}
          key={wallet.id}
        >
          <input
            checked={checked}
            className="mt-1"
            disabled={!executable}
            name="earn-vault-deposit-wallet"
            onChange={() => onSelect(wallet.id)}
            type="radio"
            value={wallet.id}
          />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-primary">
              {walletDisplayName(wallet, t("DashboardEarn.deposit.walletUnnamed"))}
            </span>
            <span className="mt-0.5 block text-xs text-tertiary">
              {shortenMarketAddress(wallet.publicKey)}
            </span>
          </span>
          <span className="shrink-0 text-right text-xs text-secondary">
            {!executable
              ? t("DashboardEarn.deposit.vaultWalletUnavailable")
              : balance === undefined
                ? t("DashboardEarn.deposit.vaultBalanceUnknown")
                : t("DashboardEarn.deposit.vaultBalanceAvailable", {
                    amount: formatTokenQuantity(balance, locale, symbol),
                  })}
          </span>
        </label>
      );
    });
  }

  return (
    <fieldset className="mt-5" disabled={submitting}>
      <legend className="text-sm font-medium text-primary">
        {t("DashboardEarn.deposit.vaultWalletTitle")}
      </legend>
      <div className="mt-2 max-h-64 space-y-2 overflow-y-auto">{walletContent}</div>
    </fieldset>
  );
}

function DepositResult({
  outcome,
  symbol,
  onClose,
}: {
  outcome: DepositOutcome;
  symbol: string;
  onClose: () => void;
}) {
  const t = useTranslations();
  const locale = useLocale();

  if (outcome.kind === "approval_pending") {
    return (
      <>
        <h2
          className="text-base font-medium text-primary outline-none"
          data-modal-focus-target
          tabIndex={-1}
        >
          {t("DashboardEarn.deposit.vaultApprovalTitle")}
        </h2>
        <p className="mt-1 text-sm leading-6 text-secondary">
          {t("DashboardEarn.deposit.vaultApprovalBody")}
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

  const { deposit } = outcome;
  // The absorbed case overrides the status copy: whatever state the movement is
  // in, the headline is that THIS submission moved nothing.
  const copy = outcome.absorbedByApproval
    ? {
        title: t("DashboardEarn.deposit.vaultAbsorbedTitle"),
        body: t("DashboardEarn.deposit.vaultAbsorbedBody"),
        note: t("DashboardEarn.deposit.vaultAbsorbedNote"),
      }
    : deposit.status === "confirmed"
      ? {
          title: t("DashboardEarn.deposit.vaultConfirmedTitle"),
          body: t("DashboardEarn.deposit.vaultConfirmedBody"),
          note: t("DashboardEarn.deposit.vaultConfirmedNote"),
        }
      : deposit.status === "pending"
        ? {
            title: t("DashboardEarn.deposit.vaultPendingTitle"),
            body: t("DashboardEarn.deposit.vaultPendingBody"),
            note: t("DashboardEarn.deposit.vaultSettlingNote"),
          }
        : {
            title: t("DashboardEarn.deposit.vaultDoneTitle"),
            body: t("DashboardEarn.deposit.vaultDoneBody"),
            note: t("DashboardEarn.deposit.vaultSettlingNote"),
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

      <dl className="mt-5 rounded-lg border border-border-default bg-fill-subtle p-4 text-sm">
        <div className="flex items-baseline justify-between gap-5 py-1">
          <dt className="text-tertiary">{t("DashboardEarn.deposit.vaultStrategy")}</dt>
          <dd className="text-right text-primary">{deposit.strategy.name}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-5 py-1">
          <dt className="text-tertiary">{t("DashboardEarn.withdraw.amountLabel")}</dt>
          <dd className="text-right tabular-nums text-primary">
            {formatTokenQuantity(outcome.amount, locale, symbol)}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-5 py-1">
          <dt className="text-tertiary">{t("DashboardEarn.deposit.vaultFrom")}</dt>
          <dd className="text-right text-primary">{outcome.walletName}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-5 py-1">
          <dt className="text-tertiary">{t("DashboardEarn.deposit.vaultTransaction")}</dt>
          <dd className="text-right">
            <a
              className="inline-flex items-center gap-1 text-primary underline underline-offset-2"
              href={explorerTxUrl(deposit.signature, deposit.strategy.hostCluster)}
              rel="noreferrer"
              target="_blank"
            >
              {shortenMarketAddress(deposit.signature)}
              <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
            </a>
          </dd>
        </div>
      </dl>
      <p className="mt-4 text-sm leading-6 text-secondary">{copy.note}</p>
      <div className="mt-6 flex justify-end">
        <Button onClick={onClose}>{t("DashboardEarn.withdraw.done")}</Button>
      </div>
    </>
  );
}

interface EarnVaultDepositOutcomeTrackerProps {
  movementId: string;
  /** Refresh the balances the deposit changed, then retire the tracker. */
  onSettled?: () => void;
}

/**
 * Keeps a recorded deposit under observation independently of the dismissible
 * modal, which is the whole point: the modal's success screen is a receipt for
 * a SIGNATURE, and the customer will close it long before the chain has
 * decided. Treasury mounts one of these per in-flight deposit; the canonical
 * hook polls until the movement is `confirmed` or `failed`, announces exactly
 * once, and then asks the caller to retire it.
 *
 * Deliberately NOT mounted for an approval-gated deposit: that path throws
 * `SIGNING_PENDING` with an approval id and NO movement id, because no movement
 * row exists until someone approves it. There is nothing to poll by id, and a
 * tracker that pretended otherwise would poll a movement that does not exist
 * and quietly report nothing (PRO-1692 — the approval path needs its own
 * answer, either a wallet-operation poll or a server-side attempt record).
 */
export function EarnVaultDepositOutcomeTracker({
  movementId,
  onSettled,
}: EarnVaultDepositOutcomeTrackerProps) {
  useEarnVaultDepositOutcomeToast(movementId, onSettled);
  return null;
}

export interface EarnVaultDepositModalProps {
  strategy: EarnStrategy;
  /**
   * The project this deposit belongs to, which is part of what makes two
   * submissions the same request — see `vaultDepositRequestFingerprint`. Passed
   * in rather than read from the workspace context so this modal stays
   * context-free and directly testable.
   */
  projectId: string | null;
  onClose: () => void;
  onDeposited?: (deposit: EarnVaultDeposit) => void;
}

/**
 * Deposit from one SDP custody wallet into one non-custodial strategy. The
 * chosen wallet signs and holds the shares; no vault address is ever presented
 * as a funding address.
 */
export function EarnVaultDepositModal({
  strategy,
  projectId,
  onClose,
  onDeposited,
}: EarnVaultDepositModalProps) {
  const t = useTranslations();
  const locale = useLocale();
  const { wallets, error: walletsError, isLoading: walletsLoading } = useEarnFundingWallets();
  const [walletId, setWalletId] = useState<string | null>(null);
  const [amountInput, setAmountInput] = useState("");
  // Declared per provider in @sdp/types: non-null means this provider REQUIRES
  // an explicit share floor, which the dashboard derives from a LIVE quote and
  // never from the deposit amount. Null renders no slippage control at all.
  const slippagePolicy = earnDepositSlippageFloor(strategy.provider);
  const [slippageInput, setSlippageInput] = useState(() =>
    slippagePolicy ? String(slippagePolicy.defaultToleranceBps) : ""
  );
  const [slippageOpen, setSlippageOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<DepositOutcome | null>(null);
  const submittingRef = useRef(false);
  const requestControllerRef = useRef<AbortController | null>(null);
  const panelKey = outcome ? `outcome:${outcome.kind}` : "form";
  const contentRef = useModalFocus({
    focusKey: panelKey,
    initialFocusSelector: "[data-modal-focus-target]",
    fallbackAttribute: "data-earn-vault-deposit-focus-fallback",
    fallbackValue: strategy.id,
    contentDataKey: "panel",
  });

  // Unmount "aborts" the SUBMISSION, not the request: the signal gates state
  // updates and the outcome screen, while the POST itself runs to completion so
  // its answer still reaches the key store (see the submit path).
  useEffect(
    () => () => {
      requestControllerRef.current?.abort();
    },
    []
  );

  const depositMint = strategy.depositMints[0];
  const mintMetadata = depositMint ? WELL_KNOWN_TOKEN_BY_MINT.get(depositMint) : undefined;
  const routedToken = strategyToken(strategy);
  const symbol =
    mintMetadata?.symbol ??
    routedToken?.toUpperCase() ??
    (depositMint ? tokenSymbol(depositMint) : "—");
  const decimals = mintMetadata?.decimals;
  const amountValidation = validateVaultDepositAmount(amountInput, decimals);
  const selectedWallet = useMemo(
    () => wallets?.find((wallet) => wallet.id === walletId && wallet.isRuntimeExecutionAllowed),
    [walletId, wallets]
  );
  const selectedWalletBalance =
    selectedWallet && depositMint && decimals !== undefined
      ? walletBalanceForMint(selectedWallet, depositMint, decimals)
      : undefined;
  const overKnownBalance =
    amountValidation.kind === "valid" && selectedWalletBalance !== undefined
      ? compareUnsignedDecimals(amountValidation.canonicalAmount, selectedWalletBalance) === 1
      : false;
  const backing = strategySourceLabel(strategy);
  const amountError = amountValidationMessage(amountInput, amountValidation, t);
  const slippageBps = slippagePolicy ? parseSlippageToleranceBps(slippageInput) : null;
  const slippageInvalid = slippagePolicy !== null && slippageBps === null;
  const [quoteRefreshKey, setQuoteRefreshKey] = useState(0);
  const quoteAmount =
    slippagePolicy !== null && amountValidation.kind === "valid"
      ? amountValidation.canonicalAmount
      : null;
  // The key serializes EVERY quote input, per the hook's contract: an amount
  // alone would keep serving the previous strategy's quote across a swap.
  const quoteKey = quoteAmount === null ? null : JSON.stringify([strategy.id, quoteAmount]);
  const rawQuote = useDebouncedVaultQuote<EarnVaultDepositPreview>(
    quoteKey,
    (signal) =>
      fetchEarnVaultDepositPreview({ strategyId: strategy.id, amount: quoteAmount ?? "" }, signal),
    quoteRefreshKey
  );
  const quote = quoteForKey(rawQuote, quoteKey);
  const minSharesOut = derivedMinSharesOut(slippageBps, quote);
  const submitBlocked =
    !selectedWallet ||
    amountValidation.kind !== "valid" ||
    (slippagePolicy !== null && minSharesOut === undefined);

  async function submitResolvedIntent(
    controller: AbortController,
    wallet: EarnFundingWallet,
    amount: string
  ) {
    // Keyed by the request itself and persisted per tab, so re-pressing submit
    // after a timeout — or after a reload that lost this component entirely —
    // replays the same key instead of signing a second transfer.
    const fingerprint = vaultDepositRequestFingerprint({
      projectId,
      strategyId: strategy.id,
      custodyWalletId: wallet.id,
      amount,
      toleranceBps: slippagePolicy === null ? null : slippageBps,
    });
    const resolvedKey = await resolveHeldIdempotencyKey(
      vaultDepositIdempotencyKeyStore,
      fingerprint,
      controller.signal,
      fetchEarnVaultDepositByRequestId
    );
    if (resolvedKey.kind === "aborted") return;
    if (resolvedKey.kind === "unavailable") {
      setSubmitError(t("DashboardEarn.deposit.vaultHeldKeyUnavailable"));
      return;
    }

    // A HELD key must replay the floor it was MINTED with, verbatim: the API's
    // idempotency fingerprint includes `minSharesOut`, so pairing the held key
    // with a freshly quoted floor would be refused as a changed request —
    // stranding the approval the hold exists to wait on. A fresh key takes the
    // freshly derived floor, and records it for exactly that future replay.
    const heldFloor = resolvedKey.wasHeld ? recallVaultDepositFloor(fingerprint) : undefined;
    const floorForRequest = heldFloor !== undefined ? heldFloor : (minSharesOut ?? null);
    rememberVaultDepositFloor(fingerprint, floorForRequest);

    // The value-moving POST deliberately takes NO abort signal. The server
    // processes the request whether or not this component survives it, so
    // aborting on unmount only blinds the client to an answer it needs: a
    // 202 approval hold whose key was never PINNED stays on the 15-minute
    // TTL while the approval itself lives for hours, and the eventual
    // resubmit mints a fresh key — a second approval request for one intent.
    // The controller still exists, but it gates the UI below, never the
    // request or the key bookkeeping.
    const result = await createEarnVaultDeposit(
      {
        strategyId: strategy.id,
        custodyWalletId: wallet.id,
        amount,
        ...(floorForRequest === null ? {} : { minSharesOut: floorForRequest }),
      },
      resolvedKey.key
    );
    // Key bookkeeping FIRST and unconditionally: the store outlives the
    // component, so an unmount mid-flight must not skip recording what the
    // server just answered.
    const disposition = applyIdempotencyKeyOutcome(
      vaultDepositIdempotencyKeyStore,
      fingerprint,
      result
    );
    // A retired key can never be replayed, so its remembered floor is dead
    // weight the next fresh derivation must not inherit.
    if (disposition === "retired") forgetVaultDepositFloor(fingerprint);
    if (controller.signal.aborted) return;
    const resolution = resolveDepositSubmission(
      result,
      amount,
      walletDisplayName(wallet, t("DashboardEarn.deposit.walletUnnamed")),
      t("DashboardEarn.deposit.vaultSubmitError"),
      resolvedKey.wasHeld,
      // A blown floor gets THIS surface's own words and the control that
      // fixes it, not a relayed simulation log.
      t("DashboardEarn.deposit.vaultSlippageExceeded")
    );
    if (resolution.kind === "error") {
      if (resolution.slippageExceeded) {
        // Open the control that fixes it, and re-quote: the retry's floor must
        // come from the rate that refused, not the one that preceded it.
        setSlippageOpen(true);
        setQuoteRefreshKey((key) => key + 1);
      }
      setSubmitError(resolution.message);
      return;
    }
    setOutcome(resolution.outcome);
    if (resolution.deposited) onDeposited?.(resolution.deposited);
  }

  async function submit() {
    if (
      submittingRef.current ||
      submitBlocked ||
      !selectedWallet ||
      amountValidation.kind !== "valid"
    ) {
      return;
    }

    const controller = new AbortController();
    requestControllerRef.current?.abort();
    requestControllerRef.current = controller;
    // Locked BEFORE the first await below, so the spent-key check cannot be
    // raced by a second press.
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);

    try {
      await submitResolvedIntent(controller, selectedWallet, amountValidation.canonicalAmount);
    } catch (cause) {
      if (!controller.signal.aborted) {
        setSubmitError(
          cause instanceof Error && cause.message
            ? cause.message
            : t("DashboardEarn.deposit.vaultSubmitError")
        );
      }
    } finally {
      if (requestControllerRef.current === controller) requestControllerRef.current = null;
      submittingRef.current = false;
      if (!controller.signal.aborted) setSubmitting(false);
    }
  }

  const modalLabel = t("DashboardEarn.deposit.vaultDepositTitle", {
    strategy: strategy.name,
  });

  if (outcome) {
    return (
      <Modal isOpen ariaLabel={modalLabel} onClose={onClose} size="md">
        <div className="p-6" ref={contentRef}>
          <DepositResult outcome={outcome} symbol={symbol} onClose={onClose} />
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
          {t("DashboardEarn.deposit.vaultWalletBody")}
        </p>

        <DepositWalletPicker
          decimals={decimals}
          depositMint={depositMint}
          onSelect={(selectedWalletId) => {
            setWalletId(selectedWalletId);
            setSubmitError(null);
          }}
          selectedWalletId={walletId}
          submitting={submitting}
          symbol={symbol}
          wallets={wallets}
          walletsError={walletsError}
          walletsLoading={walletsLoading}
        />

        <div className="mt-5 space-y-2">
          <Label htmlFor="earn-vault-deposit-amount">
            {t("DashboardEarn.deposit.vaultAmount", { token: symbol })}
          </Label>
          <Input
            aria-describedby="earn-vault-deposit-balance earn-vault-deposit-note"
            aria-invalid={amountError ? true : undefined}
            disabled={submitting || !selectedWallet || decimals === undefined}
            id="earn-vault-deposit-amount"
            inputMode="decimal"
            maxLength={MAX_AMOUNT_LENGTH}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              setAmountInput(event.target.value);
              setSubmitError(null);
            }}
            placeholder="0.00"
            value={amountInput}
          />
          <div id="earn-vault-deposit-balance" className="min-h-5 text-xs text-tertiary">
            {selectedWallet
              ? selectedWalletBalance === undefined
                ? t("DashboardEarn.deposit.vaultBalanceUnknown")
                : t("DashboardEarn.deposit.vaultBalanceAvailable", {
                    amount: formatTokenQuantity(selectedWalletBalance, locale, symbol),
                  })
              : null}
          </div>
          {amountError ? (
            <p className="text-xs text-error" role="alert">
              {amountError}
            </p>
          ) : null}
          {overKnownBalance ? (
            <p className="text-xs text-warning" role="status">
              {t("DashboardEarn.deposit.vaultOverBalance")}
            </p>
          ) : null}
        </div>

        <dl className="mt-5 rounded-lg border border-border-default bg-fill-subtle p-4 text-sm">
          <div className="flex items-baseline justify-between gap-5 py-1">
            <dt className="text-tertiary">{t("DashboardEarn.deposit.vaultStrategy")}</dt>
            <dd className="text-right text-primary">{strategy.name}</dd>
          </div>
          {backing ? (
            <div className="flex items-baseline justify-between gap-5 py-1">
              <dt className="text-tertiary">{t("DashboardEarn.deposit.vaultBacking")}</dt>
              <dd className="text-right text-primary">{backing}</dd>
            </div>
          ) : null}
          {selectedWallet ? (
            <div className="flex items-baseline justify-between gap-5 py-1">
              <dt className="text-tertiary">{t("DashboardEarn.deposit.vaultFrom")}</dt>
              <dd className="text-right text-primary">
                {walletDisplayName(selectedWallet, t("DashboardEarn.deposit.walletUnnamed"))}
              </dd>
            </div>
          ) : null}
          <DepositQuoteSummaryRows minSharesOut={minSharesOut} quote={quote} />
        </dl>

        <DepositQuoteNotices quote={quote} />

        {slippagePolicy ? (
          <VaultSlippageSection
            help={t("DashboardEarn.deposit.vaultSlippageHelp")}
            idPrefix="earn-vault-deposit"
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

        <p id="earn-vault-deposit-note" className="mt-4 text-sm leading-6 text-secondary">
          {t("DashboardEarn.deposit.vaultConfirmNote")}
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
          <Button disabled={submitting || submitBlocked} onClick={() => void submit()}>
            {submitting ? (
              <span className="inline-flex items-center gap-2">
                <Loader2Icon aria-hidden="true" className="size-4 animate-spin" />
                {t("DashboardEarn.deposit.vaultSubmitting")}
              </span>
            ) : (
              t("DashboardEarn.deposit.vaultSubmit")
            )}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
