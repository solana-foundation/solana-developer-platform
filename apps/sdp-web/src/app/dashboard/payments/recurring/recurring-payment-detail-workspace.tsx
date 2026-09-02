"use client";

import type {
  CounterpartyAccount,
  PaymentRecurringPayment,
  PaymentRecurringPaymentStatus,
  PaymentSubscriptionCollectionAttempt,
  UpdatePaymentRecurringPaymentRequest,
} from "@sdp/types";
import {
  AlertCircleIcon,
  BanIcon,
  ChevronDownIcon,
  CreditCardIcon,
  InfoIcon,
  Loader2Icon,
  PencilIcon,
  RefreshCwIcon,
  RepeatIcon,
  RotateCcwIcon,
  WalletIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { EntityLink } from "@/components/entity-link";
import { TokenMark } from "@/components/token-mark";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { useTranslations } from "@/i18n/provider";
import {
  formatTimestamp,
  isHttpUrl,
  resolveTokenByMint,
  shortenAddress,
} from "../payments-overview.utils";
import type { PaymentsIssuedTokenSymbol } from "../payments-page.data";
import { RecurringPaymentCollectionHistory } from "./recurring-payment-collection-history";
import { recurringPaymentAssetOptions } from "./recurring-payment-create-workspace";
import { getRecurringPaymentDetailState } from "./recurring-payment-detail-state";
import {
  type RecurringPaymentAction,
  runRecurringPaymentAction,
  updateRecurringPayment,
} from "./recurring-payments.data";
import {
  accountAddress,
  accountLabel,
  amountIsValid,
  CopyableValue,
  DetailRow,
  ExplorerValue,
  formatOptionalTimestamp,
  formatPeriodHours,
  getSchedulePresets,
  isDueNow,
  parsePeriodHours,
  RecurringPaymentStatusBadge,
  type RecurringPaymentWalletView,
  resolveTokenLabel,
  type SchedulePreset,
  schedulePresetForPeriodHours,
  type Translate,
  walletLabel,
} from "./recurring-payments-shared";

interface RecurringPaymentDetailWorkspaceProps {
  recurringPayment: PaymentRecurringPayment;
  wallet: RecurringPaymentWalletView | null;
  wallets: RecurringPaymentWalletView[];
  issuedTokensByMint: Record<string, PaymentsIssuedTokenSymbol>;
  counterpartyAccounts: CounterpartyAccount[];
  counterpartyLabel: string;
  amountLabel: string;
  collectionAttempts: PaymentSubscriptionCollectionAttempt[];
  collectionAttemptsTotal: number;
  collectionAttemptsError?: string;
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

function ActionBand({
  variant,
  title,
  children,
}: {
  variant: "info" | "warning" | "danger";
  title: string;
  children: ReactNode;
}) {
  const styles = {
    info: "border-border-default bg-info-bg text-info",
    warning: "border-border-default bg-warning-bg text-warning",
    danger: "border-error-border bg-error-bg text-error",
  }[variant];
  const Icon = variant === "danger" ? AlertCircleIcon : InfoIcon;

  return (
    <div className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-sm ${styles}`}>
      <Icon className="size-4 shrink-0 self-center" />
      <div className="min-w-0 space-y-1">
        <p className="font-medium">{title}</p>
        <div className="text-primary">{children}</div>
      </div>
    </div>
  );
}

interface DetailAction {
  action: RecurringPaymentAction;
  label: string;
}

interface DetailActionError {
  action: RecurringPaymentAction;
  message: string;
}

function disabledActionLabel(status: PaymentRecurringPaymentStatus, t: Translate): string | null {
  switch (status) {
    case "activating":
      return t("DashboardPayments.recurring.activating");
    case "updating":
      return t("DashboardPayments.recurring.updating");
    case "canceling":
      return t("DashboardPayments.recurring.canceling");
    case "resuming":
      return t("DashboardPayments.recurring.resuming");
    default:
      return null;
  }
}

function primaryDetailAction(
  status: PaymentRecurringPaymentStatus,
  dueNow: boolean,
  error: DetailActionError | null,
  t: Translate
): DetailAction | null {
  if (status === "pending_activation") {
    return {
      action: "activate",
      label:
        error?.action === "activate"
          ? t("DashboardPayments.recurring.retryActivation")
          : t("DashboardPayments.recurring.activate"),
    };
  }
  if (dueNow) {
    return {
      action: "collect",
      label:
        error?.action === "collect"
          ? t("DashboardPayments.recurring.retryCollection")
          : t("DashboardPayments.recurring.collectNow"),
    };
  }
  if (status === "canceled") {
    return {
      action: "resume",
      label:
        error?.action === "resume"
          ? t("DashboardPayments.recurring.retryResume")
          : t("DashboardPayments.recurring.resume"),
    };
  }
  return null;
}

function secondaryDetailAction(
  status: PaymentRecurringPaymentStatus,
  error: DetailActionError | null,
  t: Translate
): DetailAction | null {
  if (status !== "active") {
    return null;
  }
  return {
    action: "cancel",
    label:
      error?.action === "cancel"
        ? t("DashboardPayments.recurring.retryCancellation")
        : t("DashboardPayments.recurring.cancel"),
  };
}

function RecurringPaymentActionsMenu({
  status,
  dueNow,
  pendingAction,
  actionError,
  disabled,
  editable,
  onEdit,
  onAction,
  onCancel,
}: {
  status: PaymentRecurringPaymentStatus;
  dueNow: boolean;
  pendingAction: RecurringPaymentAction | null;
  actionError: DetailActionError | null;
  disabled?: boolean;
  editable: boolean;
  onEdit: () => void;
  onAction: (action: RecurringPaymentAction) => void;
  onCancel: () => void;
}) {
  const t = useTranslations();
  const disabledLabel = disabledActionLabel(status, t);
  const primaryAction = primaryDetailAction(status, dueNow, actionError, t);
  const secondaryAction = secondaryDetailAction(status, actionError, t);
  const actionsDisabled = Boolean(pendingAction) || Boolean(disabled);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={actionsDisabled}
          iconRight={<ChevronDownIcon className="size-4" />}
        >
          {t("DashboardPayments.recurring.actions")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuItem onSelect={onEdit} disabled={!editable || actionsDisabled}>
          <PencilIcon className="size-4" />
          <span>{t("DashboardPayments.recurring.editPayment")}</span>
        </DropdownMenuItem>
        {primaryAction ? (
          <DropdownMenuItem
            onSelect={() => onAction(primaryAction.action)}
            disabled={actionsDisabled}
          >
            {pendingAction === primaryAction.action ? (
              <Loader2Icon className="size-4 animate-spin" />
            ) : primaryAction.action === "resume" ? (
              <RotateCcwIcon className="size-4" />
            ) : (
              <RefreshCwIcon className="size-4" />
            )}
            <span>{primaryAction.label}</span>
          </DropdownMenuItem>
        ) : null}
        {disabledLabel ? (
          <DropdownMenuItem disabled>
            <Loader2Icon className="size-4 animate-spin" />
            <span>{disabledLabel}</span>
          </DropdownMenuItem>
        ) : null}
        {secondaryAction ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={onCancel}
              disabled={actionsDisabled}
              className="items-start text-error focus:text-error"
            >
              {pendingAction === secondaryAction.action ? (
                <Loader2Icon className="mt-0.5 size-4 animate-spin" />
              ) : (
                <BanIcon className="mt-0.5 size-4" />
              )}
              <span className="grid gap-0.5">
                <span>{secondaryAction.label}</span>
                <span className="text-xs font-normal text-error">
                  {t("DashboardPayments.recurring.stopFutureCollections")}
                </span>
              </span>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RecurringPaymentLifecycleBand({
  status,
  actionError,
}: {
  status: PaymentRecurringPaymentStatus;
  actionError: DetailActionError | null;
}) {
  const t = useTranslations();
  if (actionError) {
    return (
      <ActionBand variant="danger" title={actionFailureTitle(actionError.action, t)}>
        <div className="flex flex-wrap items-center gap-2">
          <span>{actionError.message}</span>
          <CopyableValue
            value={actionError.message}
            label={t("DashboardPayments.recurring.copyError")}
          />
        </div>
      </ActionBand>
    );
  }
  if (status === "pending_activation") {
    return (
      <ActionBand variant="info" title={t("DashboardPayments.recurring.readyToActivate")}>
        {t("DashboardPayments.recurring.readyToActivateDescription")}
      </ActionBand>
    );
  }
  if (status === "paused" || status === "expired") {
    return (
      <ActionBand
        variant="warning"
        title={t("DashboardPayments.recurring.lifecycleActionUnavailable")}
      >
        {t("DashboardPayments.recurring.lifecycleActionUnavailableDescription")}
      </ActionBand>
    );
  }
  return null;
}

export function RecurringPaymentDetailWorkspace({
  recurringPayment,
  wallet,
  wallets,
  issuedTokensByMint,
  counterpartyAccounts,
  counterpartyLabel,
  amountLabel,
  collectionAttempts,
  collectionAttemptsTotal,
  collectionAttemptsError,
}: RecurringPaymentDetailWorkspaceProps) {
  const t = useTranslations();
  const router = useRouter();
  const [pendingAction, setPendingAction] = useState<RecurringPaymentAction | null>(null);
  const [actionError, setActionError] = useState<DetailActionError | null>(null);
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  const [editingPayment, setEditingPayment] = useState(false);
  const [savingPayment, setSavingPayment] = useState(false);
  const [paymentValidationError, setPaymentValidationError] = useState<string | null>(null);
  const [selectedCustodyWalletId, setSelectedCustodyWalletId] = useState(
    recurringPayment.sourceCustodyWalletId ?? ""
  );
  const [selectedReceivingAccountId, setSelectedReceivingAccountId] = useState(
    recurringPayment.counterpartyAccountId
  );
  const [selectedSchedulePreset, setSelectedSchedulePreset] = useState<SchedulePreset>(
    schedulePresetForPeriodHours(recurringPayment.periodHours)
  );
  const [selectedCustomPeriodHours, setSelectedCustomPeriodHours] = useState(
    String(recurringPayment.periodHours)
  );
  const [selectedToken, setSelectedToken] = useState(recurringPayment.token);
  const [selectedAmount, setSelectedAmount] = useState(recurringPayment.amount);
  const scheduleLabel = formatPeriodHours(recurringPayment.periodHours, t);
  const paymentReferenceLabel = shortenAddress(recurringPayment.id);
  const sourceWalletLabel = walletLabel(wallet, recurringPayment.sourceProviderWalletId);
  const assetOptions = recurringPaymentAssetOptions(wallet, {}, t);
  const receivingAccount =
    counterpartyAccounts.find((account) => account.id === recurringPayment.counterpartyAccountId) ??
    null;
  const receivingAccountLabel = accountLabel(
    receivingAccount,
    recurringPayment.counterpartyAccountId
  );
  const receivingAccountAddress = accountAddress(receivingAccount);
  const { sourceWalletUnresolved, isEditable, controlsDisabled } = getRecurringPaymentDetailState({
    sourceCustodyWalletId: recurringPayment.sourceCustodyWalletId,
    status: recurringPayment.status,
    hasPendingAction: pendingAction !== null,
    savingPayment,
  });
  const dueNow =
    recurringPayment.status === "active" && isDueNow(recurringPayment.nextCollectionDueAt);

  const submitAction = async (action: RecurringPaymentAction) => {
    if (pendingAction) {
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

  const openPaymentEditor = () => {
    setSelectedAmount(recurringPayment.amount);
    setSelectedToken(recurringPayment.token);
    setSelectedSchedulePreset(schedulePresetForPeriodHours(recurringPayment.periodHours));
    setSelectedCustomPeriodHours(String(recurringPayment.periodHours));
    setSelectedCustodyWalletId(recurringPayment.sourceCustodyWalletId ?? "");
    setSelectedReceivingAccountId(recurringPayment.counterpartyAccountId);
    setPaymentValidationError(null);
    setEditingPayment(true);
  };

  const closePaymentEditor = () => {
    setPaymentValidationError(null);
    setEditingPayment(false);
  };

  const submitPayment = async () => {
    if (controlsDisabled) {
      return;
    }
    const amount = selectedAmount.trim();
    if (!amountIsValid(amount)) {
      setPaymentValidationError(t("DashboardPayments.recurring.invalidAmount"));
      return;
    }
    const periodHours = parsePeriodHours(selectedSchedulePreset, selectedCustomPeriodHours);
    if (!periodHours) {
      setPaymentValidationError(t("DashboardPayments.recurring.invalidInterval"));
      return;
    }
    if (!selectedToken) {
      setPaymentValidationError(t("DashboardPayments.recurring.selectCurrency"));
      return;
    }
    if (!selectedCustodyWalletId) {
      setPaymentValidationError(t("DashboardPayments.recurring.selectFundingWallet"));
      return;
    }
    if (!selectedReceivingAccountId) {
      setPaymentValidationError(t("DashboardPayments.recurring.selectReceivingWallet"));
      return;
    }

    const updates: UpdatePaymentRecurringPaymentRequest = {};
    if (amount !== recurringPayment.amount) {
      updates.amount = amount;
    }
    if (selectedToken !== recurringPayment.token) {
      updates.token = selectedToken;
    }
    if (periodHours !== recurringPayment.periodHours) {
      updates.periodHours = periodHours;
    }
    if (selectedCustodyWalletId !== recurringPayment.sourceCustodyWalletId) {
      updates.sourceCustodyWalletId = selectedCustodyWalletId;
    }
    if (selectedReceivingAccountId !== recurringPayment.counterpartyAccountId) {
      updates.counterpartyAccountId = selectedReceivingAccountId;
    }
    if (Object.keys(updates).length === 0) {
      setPaymentValidationError(t("DashboardPayments.recurring.noChangesToSave"));
      return;
    }

    setPaymentValidationError(null);
    setSavingPayment(true);
    const toastId = toast.loading(t("DashboardPayments.recurring.updatingPayment"), {
      position: "bottom-right",
    });
    try {
      await updateRecurringPayment(recurringPayment.id, updates, undefined, t);
      toast.success(t("DashboardPayments.recurring.paymentUpdated"), {
        id: toastId,
        position: "bottom-right",
      });
      setEditingPayment(false);
      router.refresh();
    } catch (error) {
      toast.error(t("DashboardPayments.recurring.paymentUpdateFailed"), {
        id: toastId,
        description:
          error instanceof Error
            ? error.message
            : t("DashboardPayments.recurring.paymentUpdateFailed"),
        position: "bottom-right",
      });
    } finally {
      setSavingPayment(false);
    }
  };

  const resolvedToken = resolveTokenByMint(
    recurringPayment.token,
    issuedTokensByMint,
    resolveTokenLabel(recurringPayment.token, wallets)
  );

  return (
    <DashboardWorkspaceOverviewPanel>
      <div className="flex min-h-full w-full flex-col gap-6">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
          <div className="flex min-w-0 flex-wrap items-start gap-x-12 gap-y-4">
            <div className="min-w-0">
              <p className="text-sm text-secondary">{t("DashboardPayments.recurring.detailTo")}</p>
              <p className="mt-1 min-w-0 truncate text-2xl font-medium tracking-tight text-primary">
                <EntityLink
                  href={`/dashboard/payments/counterparty/${encodeURIComponent(recurringPayment.counterpartyId)}`}
                >
                  {counterpartyLabel}
                </EntityLink>
              </p>
            </div>
            <div>
              <p className="text-sm text-secondary">{t("DashboardPayments.recurring.amount")}</p>
              <p className="mt-1 flex items-center gap-2 text-2xl font-medium tracking-tight text-primary">
                <TokenMark
                  mint={recurringPayment.token}
                  symbol={resolvedToken.tokenName}
                  logoUrl={resolvedToken.metadataImageUrl}
                  size="sm"
                />
                <span>{amountLabel}</span>
              </p>
            </div>
            <div>
              <p className="text-sm text-secondary">{t("DashboardPayments.recurring.frequency")}</p>
              <p className="mt-1 text-2xl font-medium tracking-tight text-primary">
                {scheduleLabel}
              </p>
            </div>
          </div>
          <RecurringPaymentActionsMenu
            status={recurringPayment.status}
            dueNow={dueNow}
            pendingAction={pendingAction}
            actionError={actionError}
            editable={isEditable}
            onEdit={openPaymentEditor}
            disabled={controlsDisabled}
            onAction={(action) => void submitAction(action)}
            onCancel={() => setCancelConfirmOpen(true)}
          />
        </div>

        {sourceWalletUnresolved ? (
          <ActionBand
            variant="warning"
            title={t("DashboardPayments.recurring.sourceWalletUnresolved")}
          >
            {t("DashboardPayments.recurring.sourceWalletUnresolvedDescription")}
          </ActionBand>
        ) : (
          <RecurringPaymentLifecycleBand
            status={recurringPayment.status}
            actionError={actionError}
          />
        )}

        <div className="grid gap-6 lg:grid-cols-2">
          <section className="flex flex-col gap-3">
            <h3 className="text-sm font-medium text-primary">
              {t("DashboardPayments.recurring.detailPaymentSection")}
            </h3>
            <div className="flex-1 rounded-lg border border-border-default bg-surface-raised px-4">
              <div className="divide-y divide-border-default">
                <DetailRow label={t("DashboardPayments.status")}>
                  <RecurringPaymentStatusBadge status={recurringPayment.status} />
                </DetailRow>
                <div className="group flex min-h-12 items-center justify-between gap-4 py-3">
                  <span className="shrink-0 text-sm text-secondary">
                    {t("DashboardPayments.recurring.amount")}
                  </span>
                  <span className="flex min-w-0 flex-wrap items-center justify-end gap-2 text-right text-sm font-medium text-primary">
                    {isEditable ? (
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        disabled={controlsDisabled}
                        aria-label={t("DashboardPayments.recurring.edit")}
                        className="opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
                        onClick={openPaymentEditor}
                      >
                        <PencilIcon className="size-4" />
                      </Button>
                    ) : null}
                    <TokenMark
                      mint={recurringPayment.token}
                      symbol={resolvedToken.tokenName}
                      logoUrl={resolvedToken.metadataImageUrl}
                      size="xs"
                    />
                    <span>{amountLabel}</span>
                  </span>
                </div>
                <div className="group flex min-h-12 items-center justify-between gap-4 py-3">
                  <span className="shrink-0 text-sm text-secondary">
                    {t("DashboardPayments.recurring.billingInterval")}
                  </span>
                  <span className="flex min-w-0 flex-wrap items-center justify-end gap-2 text-right text-sm font-medium text-primary">
                    {isEditable ? (
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        disabled={controlsDisabled}
                        aria-label={t("DashboardPayments.recurring.edit")}
                        className="opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
                        onClick={openPaymentEditor}
                      >
                        <PencilIcon className="size-4" />
                      </Button>
                    ) : null}
                    <span>{scheduleLabel}</span>
                  </span>
                </div>
                <DetailRow label={t("DashboardPayments.recurring.starts")}>
                  {formatOptionalTimestamp(recurringPayment.firstCollectionAt, t)}
                </DetailRow>
                <DetailRow label={t("DashboardPayments.recurring.nextPayment")}>
                  {formatOptionalTimestamp(recurringPayment.nextCollectionDueAt, t)}
                </DetailRow>
                <DetailRow label={t("DashboardPayments.recurring.paymentReference")}>
                  <CopyableValue value={recurringPayment.id} label={paymentReferenceLabel} />
                </DetailRow>
              </div>
            </div>
          </section>
          <section className="flex flex-col gap-3">
            <h3 className="text-sm font-medium text-primary">
              {t("DashboardPayments.recurring.detailWalletsSection")}
            </h3>
            <div className="flex-1 rounded-lg border border-border-default bg-surface-raised px-4">
              <div className="divide-y divide-border-default">
                <div className="group flex min-h-12 items-center justify-between gap-4 py-3">
                  <span className="shrink-0 text-sm text-secondary">
                    {t("DashboardPayments.recurring.fundingWallet")}
                  </span>
                  <span className="flex min-w-0 flex-wrap items-center justify-end gap-2 text-right text-sm font-medium text-primary">
                    {isEditable ? (
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        disabled={controlsDisabled || wallets.length === 0}
                        aria-label={t("DashboardPayments.recurring.edit")}
                        className="opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
                        onClick={openPaymentEditor}
                      >
                        <PencilIcon className="size-4" />
                      </Button>
                    ) : null}
                    {wallet ? (
                      <EntityLink
                        href={`/dashboard/wallets/${encodeURIComponent(wallet.walletId)}`}
                      >
                        {sourceWalletLabel}
                      </EntityLink>
                    ) : (
                      <span className="min-w-0 truncate">{sourceWalletLabel}</span>
                    )}
                    <CopyableValue
                      value={wallet?.publicKey ?? recurringPayment.sourceAddress}
                      label={shortenAddress(wallet?.publicKey ?? recurringPayment.sourceAddress)}
                    />
                  </span>
                </div>
                <div className="group flex min-h-12 items-center justify-between gap-4 py-3">
                  <span className="shrink-0 text-sm text-secondary">
                    {t("DashboardPayments.recurring.receivingWallet")}
                  </span>
                  <span className="flex min-w-0 flex-wrap items-center justify-end gap-2 text-right text-sm font-medium text-primary">
                    {isEditable ? (
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        disabled={controlsDisabled || counterpartyAccounts.length === 0}
                        aria-label={t("DashboardPayments.recurring.edit")}
                        className="opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
                        onClick={openPaymentEditor}
                      >
                        <PencilIcon className="size-4" />
                      </Button>
                    ) : null}
                    <EntityLink
                      href={`/dashboard/payments/counterparty/${encodeURIComponent(recurringPayment.counterpartyId)}`}
                    >
                      {receivingAccountLabel}
                    </EntityLink>
                    {receivingAccountAddress ? (
                      <CopyableValue
                        value={receivingAccountAddress}
                        label={shortenAddress(receivingAccountAddress)}
                      />
                    ) : null}
                  </span>
                </div>
                <DetailRow label={t("DashboardPayments.recurring.subscriptionAccount")}>
                  <ExplorerValue value={recurringPayment.subscriptionPda} kind="address" />
                </DetailRow>
                <DetailRow label={t("DashboardPayments.recurring.metadata")}>
                  {recurringPayment.metadataUri && isHttpUrl(recurringPayment.metadataUri) ? (
                    <a
                      href={recurringPayment.metadataUri}
                      target="_blank"
                      rel="noreferrer"
                      className="underline underline-offset-4"
                    >
                      {t("DashboardPayments.recurring.openMetadata")}
                    </a>
                  ) : recurringPayment.metadataUri ? (
                    <span className="block max-w-64 truncate text-tertiary">
                      {recurringPayment.metadataUri}
                    </span>
                  ) : (
                    <span className="text-tertiary">{t("DashboardPayments.recurring.notSet")}</span>
                  )}
                </DetailRow>
                <DetailRow label={t("DashboardPayments.recurring.created")}>
                  {formatTimestamp(recurringPayment.createdAt, t)}
                </DetailRow>
                <DetailRow label={t("DashboardPayments.recurring.updated")}>
                  {formatTimestamp(recurringPayment.updatedAt, t)}
                </DetailRow>
              </div>
            </div>
          </section>
        </div>

        <RecurringPaymentCollectionHistory
          attempts={collectionAttempts}
          total={collectionAttemptsTotal}
          error={collectionAttemptsError}
          wallets={wallets}
          className="min-h-0 flex-1"
        />

        <Modal
          isOpen={editingPayment}
          ariaLabel={t("DashboardPayments.recurring.editPayment")}
          onClose={savingPayment ? undefined : closePaymentEditor}
          size="sm"
        >
          <form
            className="space-y-5 p-6"
            onSubmit={(event) => {
              event.preventDefault();
              void submitPayment();
            }}
          >
            <div className="space-y-1">
              <h2 className="text-lg font-medium tracking-tight text-primary">
                {t("DashboardPayments.recurring.editPayment")}
              </h2>
              <p className="text-sm text-secondary">
                {t("DashboardPayments.recurring.editPaymentDescription")}
              </p>
            </div>
            <Combobox
              label={t("DashboardPayments.recurring.fundingWallet")}
              value={selectedCustodyWalletId}
              onChange={(value) => {
                setSelectedCustodyWalletId(value);
                setPaymentValidationError(null);
              }}
              options={wallets.map((entry) => ({
                value: entry.id,
                label: walletLabel(entry, entry.walletId),
                description: shortenAddress(entry.publicKey),
              }))}
              placeholder={t("DashboardPayments.recurring.selectFundingWallet")}
              icon={<WalletIcon />}
              disabled={savingPayment || wallets.length === 0}
            />
            <Combobox
              label={t("DashboardPayments.recurring.receivingWallet")}
              value={selectedReceivingAccountId}
              onChange={(value) => {
                setSelectedReceivingAccountId(value);
                setPaymentValidationError(null);
              }}
              options={counterpartyAccounts.map((account) => ({
                value: account.id,
                label: accountLabel(account, account.id),
                description: shortenAddress(accountAddress(account)),
              }))}
              placeholder={t("DashboardPayments.recurring.selectReceivingWallet")}
              icon={<WalletIcon />}
              disabled={savingPayment || counterpartyAccounts.length === 0}
            />
            <Combobox
              label={t("DashboardPayments.recurring.currency")}
              value={selectedToken}
              onChange={(value) => {
                setSelectedToken(value);
                setPaymentValidationError(null);
              }}
              options={assetOptions}
              placeholder={
                assetOptions.length === 0
                  ? t("DashboardPayments.recurring.noTokenBalances")
                  : t("DashboardPayments.recurring.selectCurrency")
              }
              searchPlaceholder={t("DashboardPayments.ramps.searchCurrencies")}
              icon={<CreditCardIcon />}
              disabled={savingPayment || assetOptions.length === 0}
            />
            <div className="space-y-2">
              <Label htmlFor="recurring-payment-edit-amount">
                {t("DashboardPayments.recurring.amount")}
              </Label>
              <Input
                id="recurring-payment-edit-amount"
                inputMode="decimal"
                value={selectedAmount}
                disabled={savingPayment}
                onChange={(event) => {
                  setSelectedAmount(event.currentTarget.value);
                  setPaymentValidationError(null);
                }}
                placeholder="0.00"
              />
            </div>
            <Combobox
              label={t("DashboardPayments.recurring.billingInterval")}
              value={selectedSchedulePreset}
              onChange={(value) => {
                setSelectedSchedulePreset(value as SchedulePreset);
                setPaymentValidationError(null);
              }}
              options={getSchedulePresets(t)}
              searchable={false}
              icon={<RepeatIcon />}
              disabled={savingPayment}
            />
            {selectedSchedulePreset === "custom" ? (
              <div className="space-y-2">
                <Label htmlFor="recurring-payment-edit-hours">
                  {t("DashboardPayments.recurring.intervalHours")}
                </Label>
                <Input
                  id="recurring-payment-edit-hours"
                  inputMode="numeric"
                  value={selectedCustomPeriodHours}
                  disabled={savingPayment}
                  onChange={(event) => {
                    setSelectedCustomPeriodHours(event.currentTarget.value);
                    setPaymentValidationError(null);
                  }}
                  placeholder="24"
                />
              </div>
            ) : null}
            {paymentValidationError ? (
              <p className="text-sm text-error">{paymentValidationError}</p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={savingPayment}
                onClick={closePaymentEditor}
              >
                {t("DashboardPayments.recurring.cancel")}
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={savingPayment}
                iconLeft={
                  savingPayment ? (
                    <Loader2Icon className="size-4 shrink-0 animate-spin" />
                  ) : undefined
                }
              >
                {t("DashboardPayments.recurring.save")}
              </Button>
            </div>
          </form>
        </Modal>

        <Modal
          isOpen={cancelConfirmOpen}
          ariaLabel={t("DashboardPayments.recurring.cancelPayment")}
          onClose={pendingAction === "cancel" ? undefined : () => setCancelConfirmOpen(false)}
          size="sm"
        >
          <div className="space-y-5 p-6">
            <div className="space-y-1">
              <h2 className="text-lg font-medium tracking-tight text-primary">
                {t("DashboardPayments.recurring.cancelPaymentTitle")}
              </h2>
              <p className="text-sm text-secondary">
                {t("DashboardPayments.recurring.cancelPaymentDescription", {
                  counterparty: counterpartyLabel,
                })}
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={pendingAction === "cancel"}
                onClick={() => setCancelConfirmOpen(false)}
              >
                {t("DashboardPayments.recurring.keepPayment")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={pendingAction === "cancel"}
                iconLeft={
                  pendingAction === "cancel" ? (
                    <Loader2Icon className="size-4 shrink-0 animate-spin" />
                  ) : undefined
                }
                onClick={() => {
                  void submitAction("cancel").finally(() => setCancelConfirmOpen(false));
                }}
              >
                {t("DashboardPayments.recurring.cancelPayment")}
              </Button>
            </div>
          </div>
        </Modal>
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}
