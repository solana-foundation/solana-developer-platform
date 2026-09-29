"use client";

import type {
  CounterpartyAccount,
  PaymentRecurringPayment,
  PaymentRecurringPaymentStatus,
  PaymentSubscriptionCollectionAttempt,
} from "@sdp/types";
import { ArrowUpRightIcon, Loader2Icon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { WalletMetadataCopyButton } from "@/app/dashboard/custody/wallet-address-copy-button";
import { DashboardPageTitle } from "@/components/dashboard-page-title";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import {
  RecordBlock,
  RecordColumns,
  RecordLine,
  RecordStack,
  StateBand,
  type StateBandTone,
} from "@/components/refresh-record";
import { Button } from "@/components/ui/button";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useLocale, useTranslations } from "@/i18n/provider";
import { explorerAddressUrl } from "@/lib/explorer";
import { useSolanaCluster } from "@/lib/use-solana-cluster";
import {
  formatDisplayAmount,
  isHttpUrl,
  resolveTokenByMint,
  shortenAddress,
} from "../payments-overview.utils";
import type { PaymentsIssuedTokenSymbol } from "../payments-page.data";
import { formatDateTime, formatDecimalAmount } from "../payments-presentation";
import { usePaymentsActionWallets } from "../ramps/hooks/use-payments-action-wallets";
import { RecurringPaymentRunHistory } from "./recurring-payment-collection-history";
import { getRecurringPaymentDetailState } from "./recurring-payment-detail-state";
import { RecurringPaymentEditForm } from "./recurring-payment-edit-form";
import { type RecurringPaymentAction, runRecurringPaymentAction } from "./recurring-payments.data";
import {
  accountAddress,
  formatPeriodHours,
  isDueNow,
  type RecurringPaymentWalletView,
  resolveTokenLabel,
  STATUS_TRANSLATION_KEYS,
  type Translate,
  walletLabel,
} from "./recurring-payments-shared";

type ScheduleRecord = PaymentRecurringPayment & { sourceCustodyWalletId: string };

interface RecurringPaymentDetailWorkspaceProps {
  recurringPayment: ScheduleRecord;
  wallet: RecurringPaymentWalletView | null;
  wallets: RecurringPaymentWalletView[];
  issuedTokensByMint: Record<string, PaymentsIssuedTokenSymbol>;
  counterpartyAccounts: CounterpartyAccount[];
  counterpartyLabel: string;
  collectionAttempts: PaymentSubscriptionCollectionAttempt[];
  collectionAttemptsTotal: number;
  collectionAttemptsError?: string;
}

interface DetailActionError {
  action: RecurringPaymentAction;
  message: string;
}

/** A button in the page's footer: the action it runs, its words, and whether it leads. */
interface FooterAction {
  action: RecurringPaymentAction;
  label: string;
  primary: boolean;
}

/** What the state band says: its tone, the state in a word, and what that means. */
interface Band {
  tone: StateBandTone;
  state: string;
  body: ReactNode;
}

function actionSuccessLabel(action: RecurringPaymentAction, t: Translate): string {
  switch (action) {
    case "activate":
      return t("DashboardPayments.recurring.paymentActivated");
    case "collect":
      return t("DashboardPayments.recurring.collectionSubmitted");
    case "cancel":
      return t("DashboardPayments.recurring.paymentCanceled");
    case "resume":
      return t("DashboardPayments.recurring.paymentResumed");
  }
}

function actionFailureTitle(action: RecurringPaymentAction, t: Translate): string {
  switch (action) {
    case "activate":
      return t("DashboardPayments.recurring.activationFailed");
    case "collect":
      return t("DashboardPayments.recurring.collectionFailed");
    case "cancel":
      return t("DashboardPayments.recurring.cancellationFailed");
    case "resume":
      return t("DashboardPayments.recurring.resumeFailed");
  }
}

/** What the band and the button say while a request is out: the action, in progress. */
function actionWorkingLabel(action: RecurringPaymentAction, t: Translate): string {
  switch (action) {
    case "activate":
      return t("DashboardPayments.recurring.activating");
    case "collect":
      return t("DashboardPayments.recurring.collecting");
    case "cancel":
      return t("DashboardPayments.recurring.canceling");
    case "resume":
      return t("DashboardPayments.recurring.resuming");
  }
}

/** The run tried last, by when it was tried: a retry that settled a failed run supersedes it. */
function latestAttempt(
  attempts: PaymentSubscriptionCollectionAttempt[]
): PaymentSubscriptionCollectionAttempt | undefined {
  let latest: PaymentSubscriptionCollectionAttempt | undefined;
  for (const attempt of attempts) {
    const at = attempt.attemptedAt ?? attempt.createdAt;
    if (latest === undefined || at > (latest.attemptedAt ?? latest.createdAt)) latest = attempt;
  }
  return latest;
}

/**
 * The footer's actions for a status, as the design orders them: the one that moves the
 * schedule forward first, Cancel last.
 */
function footerActionIds(
  recurringPayment: PaymentRecurringPayment,
  dueNow: boolean
): RecurringPaymentAction[] {
  switch (recurringPayment.status) {
    case "pending_activation":
      return ["activate", "cancel"];
    case "active":
      return dueNow ? ["collect", "cancel"] : ["cancel"];
    case "canceled":
      // Only a schedule that ran on chain has a subscription to resume; one canceled before
      // activation has to be created again.
      return recurringPayment.subscriptionId ? ["resume"] : [];
    default:
      return [];
  }
}

/** An action's words: a retry after it failed, and Retry now for a failed run still due. */
function footerActionLabel(
  action: RecurringPaymentAction,
  retrying: boolean,
  lastRunFailed: boolean,
  t: Translate
): string {
  switch (action) {
    case "activate":
      return retrying
        ? t("DashboardPayments.recurring.retryActivation")
        : t("DashboardPayments.recurring.activateSchedule");
    case "collect":
      if (retrying) return t("DashboardPayments.recurring.retryCollection");
      return lastRunFailed
        ? t("DashboardPayments.recurring.retryNow")
        : t("DashboardPayments.recurring.collectNow");
    case "cancel":
      return retrying
        ? t("DashboardPayments.recurring.retryCancellation")
        : t("DashboardPayments.recurring.cancelPayment");
    case "resume":
      return retrying
        ? t("DashboardPayments.recurring.retryResume")
        : t("DashboardPayments.recurring.resumeSchedule");
  }
}

/** Activate and Resume lead; Collect leads only as the retry of a failed run. */
function footerActions({
  recurringPayment,
  dueNow,
  lastRunFailed,
  actionError,
  t,
}: {
  recurringPayment: PaymentRecurringPayment;
  dueNow: boolean;
  lastRunFailed: boolean;
  actionError: DetailActionError | null;
  t: Translate;
}): FooterAction[] {
  return footerActionIds(recurringPayment, dueNow).map((action) => ({
    action,
    label: footerActionLabel(action, actionError?.action === action, lastRunFailed, t),
    primary:
      action === "activate" || action === "resume" || (action === "collect" && lastRunFailed),
  }));
}

/** A request in flight, or the one that just failed, heads the band over anything else. */
function requestBand({
  pendingAction,
  saving,
  actionError,
  t,
}: {
  pendingAction: RecurringPaymentAction | null;
  saving: boolean;
  actionError: DetailActionError | null;
  t: Translate;
}): Band | null {
  if (pendingAction !== null || saving) {
    return {
      tone: "info",
      state: pendingAction
        ? actionWorkingLabel(pendingAction, t)
        : t("DashboardPayments.recurring.updating"),
      body: t("DashboardPayments.recurring.stateWorkingBody"),
    };
  }
  return actionError
    ? { tone: "error", state: actionFailureTitle(actionError.action, t), body: actionError.message }
    : null;
}

/** Then whatever stops the schedule's actions: an unknown wallet, or one that cannot sign. */
function walletBand({
  sourceWalletUnresolved,
  signingDisabled,
  signingUnavailable,
  walletsError,
  status,
  sourceWalletLabel,
  t,
}: {
  sourceWalletUnresolved: boolean;
  signingDisabled: boolean;
  signingUnavailable: boolean;
  walletsError: string | null;
  status: PaymentRecurringPaymentStatus;
  sourceWalletLabel: string;
  t: Translate;
}): Band | null {
  if (sourceWalletUnresolved) {
    return {
      tone: "warn",
      state: t("DashboardPayments.recurring.sourceWalletUnresolved"),
      body: t("DashboardPayments.recurring.sourceWalletUnresolvedDescription"),
    };
  }
  if (signingDisabled) {
    return {
      tone: "warn",
      state: t("DashboardPayments.recurring.signingDisabledTitle"),
      // Cancel stays open for a pending schedule, so its body promises activation only.
      body: t(
        status === "pending_activation"
          ? "DashboardPayments.recurring.signingDisabledPendingBody"
          : "DashboardPayments.recurring.signingDisabledBody",
        { wallet: sourceWalletLabel }
      ),
    };
  }
  if (walletsError || signingUnavailable) {
    return {
      tone: "warn",
      state: t("DashboardPayments.recurring.sourceWalletUnresolved"),
      body: walletsError ?? t("DashboardPayments.signingUnavailable"),
    };
  }
  return null;
}

/** Otherwise the status itself, in the design's words for it. */
function statusBand({
  recurringPayment,
  lastRunFailed,
  scheduleLabel,
  locale,
  t,
}: {
  recurringPayment: PaymentRecurringPayment;
  lastRunFailed: boolean;
  scheduleLabel: string;
  locale: string;
  t: Translate;
}): Band {
  const state = t(STATUS_TRANSLATION_KEYS[recurringPayment.status]);
  switch (recurringPayment.status) {
    case "pending_activation":
      return { tone: "warn", state, body: t("DashboardPayments.recurring.statePendingBody") };
    case "active": {
      if (lastRunFailed) {
        return {
          tone: "error",
          state: t("DashboardPayments.recurring.lastRunFailed"),
          body: t("DashboardPayments.recurring.stateFailedBody"),
        };
      }
      const next = formatDateTime(recurringPayment.nextCollectionDueAt, locale);
      return {
        tone: "ok",
        state,
        body: next
          ? t("DashboardPayments.recurring.stateActiveBody", {
              schedule: scheduleLabel,
              date: next,
            })
          : t("DashboardPayments.recurring.stateActiveNoNextBody", { schedule: scheduleLabel }),
      };
    }
    case "paused":
      return { tone: "warn", state, body: t("DashboardPayments.recurring.statePausedBody") };
    case "canceled":
      return {
        tone: "neutral",
        state,
        body: recurringPayment.subscriptionId
          ? t("DashboardPayments.recurring.stateCanceledBody")
          : t("DashboardPayments.recurring.stateCanceledBeforeRunBody"),
      };
    case "expired":
      return { tone: "neutral", state, body: t("DashboardPayments.recurring.stateExpiredBody") };
    default:
      // Activating, updating, canceling, resuming: the network has the schedule.
      return { tone: "info", state, body: t("DashboardPayments.recurring.stateWorkingBody") };
  }
}

/** When the next run is, or why there is none. */
function nextRunLabel(recurringPayment: PaymentRecurringPayment, locale: string, t: Translate) {
  if (recurringPayment.nextCollectionDueAt) {
    return formatDateTime(recurringPayment.nextCollectionDueAt, locale);
  }
  if (recurringPayment.status !== "pending_activation") {
    return t("DashboardPayments.recurring.nothingScheduled");
  }
  return recurringPayment.firstCollectionAt
    ? formatDateTime(recurringPayment.firstCollectionAt, locale)
    : t("DashboardPayments.recurring.firstRunAfterActivation");
}

/** A value's identifier after it: shortened, the whole of it on hover, and a copy button. */
function CopyableId({
  value,
  label,
  muted = true,
}: {
  value: string;
  label: string;
  muted?: boolean;
}) {
  return (
    <span className="-my-0.5 inline-flex min-w-0 items-center gap-1.5">
      <span className={muted ? "truncate text-secondary" : "truncate"} title={value}>
        {shortenAddress(value)}
      </span>
      <WalletMetadataCopyButton value={value} label={label} />
    </span>
  );
}

const ROW_LINK =
  "min-w-0 truncate hover:underline focus-visible:underline focus-visible:outline-none";

/** What the schedule does, as the design reads it: who is paid what, from where, how often. */
function SchedulePlan({
  recurringPayment,
  wallet,
  counterpartyLabel,
  counterpartyAccounts,
  tokenLabel,
  scheduleLabel,
}: {
  recurringPayment: ScheduleRecord;
  wallet: RecurringPaymentWalletView | null;
  counterpartyLabel: string;
  counterpartyAccounts: CounterpartyAccount[];
  tokenLabel: string;
  scheduleLabel: string;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const custodyEnabled = useDashboardWorkspace().flags.custody;
  const sourceWalletLabel = walletLabel(wallet, recurringPayment.sourceProviderWalletId);
  const receivingAccount = counterpartyAccounts.find(
    (account) => account.id === recurringPayment.counterpartyAccountId
  );
  const receivingAddress =
    accountAddress(receivingAccount ?? null) || recurringPayment.destinationAddress;
  const lapsed = recurringPayment.status === "canceled" || recurringPayment.status === "expired";
  return (
    <dl>
      <RecordLine label={t("DashboardPayments.recurring.pays")}>
        {formatDecimalAmount(recurringPayment.amount, locale)} {tokenLabel}
      </RecordLine>
      <RecordLine label={t("DashboardPayments.recurring.detailTo")}>
        <Link
          href={`/dashboard/payments/counterparty/${encodeURIComponent(recurringPayment.counterpartyId)}`}
          className={ROW_LINK}
        >
          {counterpartyLabel}
        </Link>
        {receivingAddress ? (
          <CopyableId value={receivingAddress} label={t("DashboardPayments.recurring.detailTo")} />
        ) : null}
      </RecordLine>
      <RecordLine label={t("DashboardPayments.recurring.from")}>
        {wallet && custodyEnabled ? (
          <Link
            href={`/dashboard/wallets/${encodeURIComponent(wallet.walletId)}`}
            className={ROW_LINK}
          >
            {sourceWalletLabel}
          </Link>
        ) : (
          <span className="min-w-0 truncate">{sourceWalletLabel}</span>
        )}
        <CopyableId
          value={wallet === null ? recurringPayment.sourceAddress : wallet.publicKey}
          label={t("DashboardPayments.recurring.from")}
        />
      </RecordLine>
      <RecordLine label={t("DashboardPayments.recurring.repeats")}>{scheduleLabel}</RecordLine>
      <RecordLine label={t("DashboardPayments.recurring.nextRun")}>
        {nextRunLabel(recurringPayment, locale, t)}
      </RecordLine>
      {lapsed ? null : (
        <RecordLine label={t("DashboardPayments.recurring.ends")}>
          {t("DashboardPayments.recurring.noEndDate")}
        </RecordLine>
      )}
      <RecordLine label={t("DashboardPayments.recurring.ifRunFails")}>
        {t("DashboardPayments.recurring.staysActive")}
      </RecordLine>
    </dl>
  );
}

/** The schedule's identifiers and dates: its ID, its subscription on chain, when it changed. */
function ScheduleDetails({ recurringPayment }: { recurringPayment: PaymentRecurringPayment }) {
  const t = useTranslations();
  const locale = useLocale();
  const cluster = useSolanaCluster();
  const { subscriptionPda, metadataUri } = recurringPayment;
  return (
    <RecordColumns>
      <dl>
        <RecordLine label={t("DashboardPayments.recurring.scheduleId")}>
          <CopyableId
            value={recurringPayment.id}
            label={t("DashboardPayments.recurring.scheduleId")}
            muted={false}
          />
        </RecordLine>
        <RecordLine label={t("DashboardPayments.recurring.subscriptionAccount")}>
          {subscriptionPda ? (
            <>
              <CopyableId
                value={subscriptionPda}
                label={t("DashboardPayments.recurring.subscriptionAccount")}
                muted={false}
              />
              <a
                href={explorerAddressUrl(subscriptionPda, cluster)}
                target="_blank"
                rel="noreferrer"
                aria-label={t("DashboardPayments.recurring.openAccount")}
                className="inline-flex items-center gap-1 text-secondary hover:text-primary focus-visible:underline focus-visible:outline-none"
              >
                {t("DashboardPayments.recurring.open")}
                <ArrowUpRightIcon className="size-3.5" aria-hidden="true" />
              </a>
            </>
          ) : (
            <span className="text-tertiary">{t("DashboardPayments.recurring.notSet")}</span>
          )}
        </RecordLine>
        {metadataUri ? (
          <RecordLine label={t("DashboardPayments.recurring.metadata")}>
            {isHttpUrl(metadataUri) ? (
              <a
                href={metadataUri}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-4"
              >
                {t("DashboardPayments.recurring.openMetadata")}
              </a>
            ) : (
              <span className="min-w-0 truncate text-secondary">{metadataUri}</span>
            )}
          </RecordLine>
        ) : null}
      </dl>
      <dl>
        <RecordLine label={t("DashboardPayments.recurring.created")}>
          {formatDateTime(recurringPayment.createdAt, locale)}
        </RecordLine>
        <RecordLine label={t("DashboardPayments.recurring.updated")}>
          {formatDateTime(recurringPayment.updatedAt, locale)}
        </RecordLine>
      </dl>
    </RecordColumns>
  );
}

/**
 * The inline question Cancel asks before it acts, as the design sets it under the footer's
 * buttons: what cancelling means, then Keep it and Cancel schedule. It takes focus as it opens.
 */
function CancelConfirm({
  body,
  busy,
  disabled,
  onKeep,
  onConfirm,
}: {
  body: string;
  busy: boolean;
  disabled: boolean;
  onKeep: () => void;
  onConfirm: () => void;
}) {
  const t = useTranslations();
  const panelRef = useRef<HTMLFieldSetElement>(null);
  useEffect(() => {
    panelRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
    panelRef.current?.scrollIntoView({ block: "nearest" });
  }, []);
  const head = t("DashboardPayments.recurring.cancelConfirmHead");
  return (
    <fieldset
      ref={panelRef}
      aria-label={head}
      className="min-w-0 rounded-card border border-error/32 bg-error/8 p-4 text-body"
    >
      <p className="max-w-[40em] text-secondary">
        <b className="mb-1 block font-medium text-error">{head}</b>
        {body}
      </p>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-4">
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onKeep}>
          {t("DashboardPayments.recurring.keepIt")}
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          disabled={disabled}
          iconLeft={busy ? <Loader2Icon className="size-4 shrink-0 animate-spin" /> : undefined}
          onClick={onConfirm}
        >
          {busy
            ? t("DashboardPayments.recurring.canceling")
            : t("DashboardPayments.recurring.cancelPayment")}
        </Button>
      </div>
    </fieldset>
  );
}

/**
 * The footer under a rule, as the design closes the page: the actions the status allows, Cancel
 * pushed to the far end and asking first, and a note where nothing can be done.
 */
function ScheduleFooter({
  actions,
  status,
  pendingAction,
  signingActionsDisabled,
  cancelDisabled,
  onAction,
}: {
  actions: FooterAction[];
  status: PaymentRecurringPaymentStatus;
  pendingAction: RecurringPaymentAction | null;
  signingActionsDisabled: boolean;
  cancelDisabled: boolean;
  onAction: (action: RecurringPaymentAction) => Promise<void>;
}) {
  const t = useTranslations();
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const foot = status === "expired" ? t("DashboardPayments.recurring.expiredFoot") : null;
  if (actions.length === 0 && foot === null) return null;
  const canCancel = actions.some((entry) => entry.action === "cancel");
  return (
    <div className="flex flex-col gap-4 border-t border-border-default pt-4">
      {actions.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3">
          {actions.map((entry, index) => {
            const isCancel = entry.action === "cancel";
            const busy = !isCancel && pendingAction === entry.action;
            return (
              <Fragment key={entry.action}>
                {isCancel && index > 0 ? <span className="flex-1" /> : null}
                <Button
                  type="button"
                  variant={entry.primary ? "default" : "outline"}
                  size="sm"
                  disabled={isCancel ? cancelDisabled : signingActionsDisabled}
                  aria-expanded={isCancel ? confirmingCancel : undefined}
                  iconLeft={
                    busy ? <Loader2Icon className="size-4 shrink-0 animate-spin" /> : undefined
                  }
                  onClick={() =>
                    isCancel ? setConfirmingCancel((open) => !open) : void onAction(entry.action)
                  }
                >
                  {busy ? actionWorkingLabel(entry.action, t) : entry.label}
                </Button>
              </Fragment>
            );
          })}
        </div>
      ) : null}
      {foot ? <p className="text-meta text-secondary">{foot}</p> : null}
      {confirmingCancel && canCancel ? (
        <CancelConfirm
          body={
            status === "pending_activation"
              ? t("DashboardPayments.recurring.cancelConfirmPendingBody")
              : t("DashboardPayments.recurring.cancelConfirmActiveBody")
          }
          busy={pendingAction === "cancel"}
          disabled={cancelDisabled}
          onKeep={() => setConfirmingCancel(false)}
          onConfirm={() => {
            void onAction("cancel").finally(() => setConfirmingCancel(false));
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * One schedule, as the design lays it out: its state on a band, what it will do (edited in
 * place), the runs it has made, its identifiers, and the actions its state allows in a footer.
 * The header titles it as the Schedules list names it ("2,400 USDC to Northwind Fund").
 */
export function RecurringPaymentDetailWorkspace({
  recurringPayment,
  wallet,
  wallets,
  issuedTokensByMint,
  counterpartyAccounts,
  counterpartyLabel,
  collectionAttempts,
  collectionAttemptsTotal,
  collectionAttemptsError,
}: RecurringPaymentDetailWorkspaceProps) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const [pendingAction, setPendingAction] = useState<RecurringPaymentAction | null>(null);
  const [actionError, setActionError] = useState<DetailActionError | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const { liveWallets, liveWalletsError } = usePaymentsActionWallets(wallets, null);
  const liveSourceWallet = liveWallets.find(
    (entry) => entry.id === recurringPayment.sourceCustodyWalletId
  );
  const {
    sourceWalletUnresolved,
    isEditable,
    controlsDisabled,
    signingUnavailable,
    signingDisabled,
    signingActionsDisabled,
    cancelDisabled,
  } = getRecurringPaymentDetailState({
    sourceCustodyWalletId: recurringPayment.sourceCustodyWalletId,
    status: recurringPayment.status,
    hasPendingAction: pendingAction !== null,
    savingPayment: saving,
    sourceWallet: liveSourceWallet,
    selectedWallet: liveSourceWallet,
    selectedCustodyWalletId: recurringPayment.sourceCustodyWalletId,
  });
  const status = recurringPayment.status;
  const tokenLabel = resolveTokenByMint(
    recurringPayment.token,
    issuedTokensByMint,
    resolveTokenLabel(recurringPayment.token, wallets)
  ).tokenName;
  const scheduleTitle = t("DashboardPayments.recurring.amountToCounterparty", {
    amount: formatDisplayAmount(recurringPayment.amount, tokenLabel, locale),
    counterparty: counterpartyLabel,
  });
  const scheduleLabel = formatPeriodHours(recurringPayment.periodHours, t);
  const lastRunFailed =
    status === "active" && latestAttempt(collectionAttempts)?.status === "failed";
  const actions = footerActions({
    recurringPayment,
    dueNow: status === "active" && isDueNow(recurringPayment.nextCollectionDueAt),
    lastRunFailed,
    actionError,
    t,
  });

  const submitAction = async (action: RecurringPaymentAction) => {
    if (action === "cancel" ? cancelDisabled : signingActionsDisabled) {
      return;
    }

    setPendingAction(action);
    setActionError(null);
    const toastId = toast.loading(t("DashboardPayments.recurring.updatingPayment"), {
      position: "bottom-right",
    });
    try {
      await runRecurringPaymentAction(recurringPayment.id, action, undefined, t);
      toast.success(actionSuccessLabel(action, t), { id: toastId, position: "bottom-right" });
      router.refresh();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : t("DashboardPayments.recurring.actionFailed");
      setActionError({ action, message });
      toast.error(actionFailureTitle(action, t), {
        id: toastId,
        description: message,
        position: "bottom-right",
      });
    } finally {
      setPendingAction(null);
    }
  };

  // Signing only matters while there is something left to sign for.
  const band =
    requestBand({ pendingAction, saving, actionError, t }) ??
    (actions.length > 0
      ? walletBand({
          sourceWalletUnresolved,
          signingDisabled,
          signingUnavailable,
          walletsError: liveWalletsError,
          status,
          sourceWalletLabel: walletLabel(wallet, recurringPayment.sourceProviderWalletId),
          t,
        })
      : null) ??
    statusBand({ recurringPayment, lastRunFailed, scheduleLabel, locale, t });
  const canEdit = isEditable && !controlsDisabled && !editing;

  return (
    <DashboardWorkspaceOverviewPanel>
      <DashboardPageTitle title={scheduleTitle} />
      <div className="flex flex-col gap-6" data-schedule-detail={status}>
        <StateBand tone={band.tone} state={band.state}>
          {band.body}
        </StateBand>

        <RecordStack>
          <RecordBlock
            title={t("DashboardPayments.recurring.whatThisWillDo")}
            aside={
              canEdit ? (
                <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
                  {t("DashboardPayments.recurring.edit")}
                </Button>
              ) : null
            }
          >
            {editing ? (
              <RecurringPaymentEditForm
                recurringPayment={recurringPayment}
                wallet={wallet}
                liveWallets={liveWallets}
                counterpartyAccounts={counterpartyAccounts}
                hasPendingAction={pendingAction !== null}
                saving={saving}
                onSavingChange={setSaving}
                onClose={() => setEditing(false)}
              />
            ) : (
              <SchedulePlan
                recurringPayment={recurringPayment}
                wallet={wallet}
                counterpartyLabel={counterpartyLabel}
                counterpartyAccounts={counterpartyAccounts}
                tokenLabel={tokenLabel}
                scheduleLabel={scheduleLabel}
              />
            )}
          </RecordBlock>

          <RecordBlock
            title={t("DashboardPayments.recurring.runHistory")}
            aside={
              collectionAttempts.length > 0 && !collectionAttemptsError ? (
                <span className="text-body text-secondary tabular-nums">
                  {collectionAttemptsTotal === 1
                    ? t("DashboardPayments.recurring.oneAttempt")
                    : t("DashboardPayments.recurring.showingAttempts", {
                        shown: collectionAttempts.length,
                        total: collectionAttemptsTotal,
                      })}
                </span>
              ) : null
            }
          >
            <RecurringPaymentRunHistory
              attempts={collectionAttempts}
              error={collectionAttemptsError}
              tokenLabel={tokenLabel}
              pendingActivation={status === "pending_activation"}
            />
          </RecordBlock>

          <RecordBlock title={t("DashboardPayments.recurring.details")}>
            <ScheduleDetails recurringPayment={recurringPayment} />
          </RecordBlock>
        </RecordStack>

        <ScheduleFooter
          actions={actions}
          status={status}
          pendingAction={pendingAction}
          signingActionsDisabled={signingActionsDisabled}
          cancelDisabled={cancelDisabled}
          onAction={submitAction}
        />
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}
