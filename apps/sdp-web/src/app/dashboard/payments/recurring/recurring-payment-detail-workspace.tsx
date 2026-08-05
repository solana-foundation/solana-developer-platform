"use client";

import type {
  CounterpartyAccount,
  PaymentRecurringPayment,
  PaymentRecurringPaymentStatus,
  PaymentSubscriptionCollectionAttempt,
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
import { useDashboardRouter } from "@/lib/use-dashboard-router";
import {
  formatTimestamp,
  isHttpUrl,
  resolveTokenByMint,
  shortenAddress,
} from "../payments-overview.utils";
import type { PaymentsIssuedTokenSymbol } from "../payments-page.data";
import { RecurringPaymentCollectionHistory } from "./recurring-payment-collection-history";
import { recurringPaymentAssetOptions } from "./recurring-payment-create-workspace";
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
  currencyLabel: string;
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

function canEditRecurringPayment(status: PaymentRecurringPaymentStatus): boolean {
  return status === "pending_activation" || status === "active";
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: detail editing intentionally centralizes lifecycle and modal state in one workspace.
export function RecurringPaymentDetailWorkspace({
  recurringPayment,
  wallet,
  wallets,
  issuedTokensByMint,
  counterpartyAccounts,
  counterpartyLabel,
  amountLabel,
  currencyLabel,
  collectionAttempts,
  collectionAttemptsTotal,
  collectionAttemptsError,
}: RecurringPaymentDetailWorkspaceProps) {
  const t = useTranslations();
  const router = useDashboardRouter();
  const [pendingAction, setPendingAction] = useState<RecurringPaymentAction | null>(null);
  const [actionError, setActionError] = useState<DetailActionError | null>(null);
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  const [editingWallet, setEditingWallet] = useState(false);
  const [selectedWalletId, setSelectedWalletId] = useState(recurringPayment.sourceWalletId);
  const [walletValidationError, setWalletValidationError] = useState<string | null>(null);
  const [savingWallet, setSavingWallet] = useState(false);
  const [editingReceivingAccount, setEditingReceivingAccount] = useState(false);
  const [selectedReceivingAccountId, setSelectedReceivingAccountId] = useState(
    recurringPayment.counterpartyAccountId
  );
  const [receivingAccountValidationError, setReceivingAccountValidationError] = useState<
    string | null
  >(null);
  const [savingReceivingAccount, setSavingReceivingAccount] = useState(false);
  const [editingBillingInterval, setEditingBillingInterval] = useState(false);
  const [selectedSchedulePreset, setSelectedSchedulePreset] = useState<SchedulePreset>(
    schedulePresetForPeriodHours(recurringPayment.periodHours)
  );
  const [selectedCustomPeriodHours, setSelectedCustomPeriodHours] = useState(
    String(recurringPayment.periodHours)
  );
  const [billingIntervalValidationError, setBillingIntervalValidationError] = useState<
    string | null
  >(null);
  const [savingBillingInterval, setSavingBillingInterval] = useState(false);
  const [editingCurrency, setEditingCurrency] = useState(false);
  const [selectedToken, setSelectedToken] = useState(recurringPayment.token);
  const [currencyValidationError, setCurrencyValidationError] = useState<string | null>(null);
  const [savingCurrency, setSavingCurrency] = useState(false);
  const [editingAmount, setEditingAmount] = useState(false);
  const [selectedAmount, setSelectedAmount] = useState(recurringPayment.amount);
  const [amountValidationError, setAmountValidationError] = useState<string | null>(null);
  const [savingAmount, setSavingAmount] = useState(false);
  const scheduleLabel = formatPeriodHours(recurringPayment.periodHours, t);
  const paymentReferenceLabel = shortenAddress(recurringPayment.id);
  const sourceWalletLabel = walletLabel(wallet, recurringPayment.sourceWalletId);
  const assetOptions = recurringPaymentAssetOptions(wallet, {}, t);
  const receivingAccount =
    counterpartyAccounts.find((account) => account.id === recurringPayment.counterpartyAccountId) ??
    null;
  const receivingAccountLabel = accountLabel(
    receivingAccount,
    recurringPayment.counterpartyAccountId
  );
  const receivingAccountAddress = accountAddress(receivingAccount);
  const dueNow =
    recurringPayment.status === "active" && isDueNow(recurringPayment.nextCollectionDueAt);
  const isEditable = canEditRecurringPayment(recurringPayment.status);
  const controlsDisabled =
    Boolean(pendingAction) ||
    savingWallet ||
    savingReceivingAccount ||
    savingBillingInterval ||
    savingCurrency ||
    savingAmount;

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

  const submitSourceWallet = async (walletId = selectedWalletId) => {
    if (controlsDisabled) {
      return;
    }
    if (!walletId) {
      setWalletValidationError(t("DashboardPayments.recurring.selectFundingWallet"));
      return;
    }
    if (walletId === recurringPayment.sourceWalletId) {
      setWalletValidationError(
        t("DashboardPayments.recurring.alreadyFundingWallet", { wallet: sourceWalletLabel })
      );
      return;
    }

    setWalletValidationError(null);
    setSavingWallet(true);
    const toastId = toast.loading(t("DashboardPayments.recurring.updatingFundingWallet"), {
      position: "bottom-right",
    });
    try {
      await updateRecurringPayment(recurringPayment.id, { sourceWalletId: walletId }, undefined, t);
      toast.success(t("DashboardPayments.recurring.fundingWalletUpdated"), {
        id: toastId,
        position: "bottom-right",
      });
      setEditingWallet(false);
      router.refresh();
    } catch (error) {
      toast.error(t("DashboardPayments.recurring.fundingWalletUpdateFailed"), {
        id: toastId,
        description:
          error instanceof Error
            ? error.message
            : t("DashboardPayments.recurring.paymentUpdateFailed"),
        position: "bottom-right",
      });
    } finally {
      setSavingWallet(false);
    }
  };

  const closeFundingWalletModal = () => {
    setSelectedWalletId(recurringPayment.sourceWalletId);
    setWalletValidationError(null);
    setEditingWallet(false);
  };

  const submitReceivingAccount = async (accountId = selectedReceivingAccountId) => {
    if (controlsDisabled) {
      return;
    }
    if (!accountId) {
      setReceivingAccountValidationError(t("DashboardPayments.recurring.selectReceivingWallet"));
      return;
    }
    if (accountId === recurringPayment.counterpartyAccountId) {
      setReceivingAccountValidationError(
        t("DashboardPayments.recurring.alreadyReceivingWallet", { wallet: receivingAccountLabel })
      );
      return;
    }

    setReceivingAccountValidationError(null);
    setSavingReceivingAccount(true);
    const toastId = toast.loading(t("DashboardPayments.recurring.updatingReceivingWallet"), {
      position: "bottom-right",
    });
    try {
      await updateRecurringPayment(
        recurringPayment.id,
        { counterpartyAccountId: accountId },
        undefined,
        t
      );
      toast.success(t("DashboardPayments.recurring.receivingWalletUpdated"), {
        id: toastId,
        position: "bottom-right",
      });
      setEditingReceivingAccount(false);
      router.refresh();
    } catch (error) {
      toast.error(t("DashboardPayments.recurring.receivingWalletUpdateFailed"), {
        id: toastId,
        description:
          error instanceof Error
            ? error.message
            : t("DashboardPayments.recurring.paymentUpdateFailed"),
        position: "bottom-right",
      });
    } finally {
      setSavingReceivingAccount(false);
    }
  };

  const closeReceivingAccountModal = () => {
    setSelectedReceivingAccountId(recurringPayment.counterpartyAccountId);
    setReceivingAccountValidationError(null);
    setEditingReceivingAccount(false);
  };

  const submitBillingInterval = async () => {
    if (controlsDisabled) {
      return;
    }
    const periodHours = parsePeriodHours(selectedSchedulePreset, selectedCustomPeriodHours);
    if (!periodHours) {
      setBillingIntervalValidationError(t("DashboardPayments.recurring.invalidInterval"));
      return;
    }
    if (periodHours === recurringPayment.periodHours) {
      setBillingIntervalValidationError(
        t("DashboardPayments.recurring.alreadySet", { value: formatPeriodHours(periodHours, t) })
      );
      return;
    }

    setBillingIntervalValidationError(null);
    setSavingBillingInterval(true);
    const toastId = toast.loading(t("DashboardPayments.recurring.updatingBillingInterval"), {
      position: "bottom-right",
    });
    try {
      await updateRecurringPayment(recurringPayment.id, { periodHours }, undefined, t);
      toast.success(t("DashboardPayments.recurring.billingIntervalUpdated"), {
        id: toastId,
        position: "bottom-right",
      });
      setEditingBillingInterval(false);
      router.refresh();
    } catch (error) {
      toast.error(t("DashboardPayments.recurring.billingIntervalUpdateFailed"), {
        id: toastId,
        description:
          error instanceof Error
            ? error.message
            : t("DashboardPayments.recurring.paymentUpdateFailed"),
        position: "bottom-right",
      });
    } finally {
      setSavingBillingInterval(false);
    }
  };

  const closeBillingIntervalModal = () => {
    setSelectedSchedulePreset(schedulePresetForPeriodHours(recurringPayment.periodHours));
    setSelectedCustomPeriodHours(String(recurringPayment.periodHours));
    setBillingIntervalValidationError(null);
    setEditingBillingInterval(false);
  };

  const submitCurrency = async (token = selectedToken) => {
    if (controlsDisabled) {
      return;
    }
    if (!token) {
      setCurrencyValidationError(t("DashboardPayments.recurring.selectCurrency"));
      return;
    }
    if (token === recurringPayment.token) {
      setCurrencyValidationError(
        t("DashboardPayments.recurring.alreadyCurrency", {
          currency: resolveTokenLabel(token, wallets),
        })
      );
      return;
    }

    setCurrencyValidationError(null);
    setSavingCurrency(true);
    const toastId = toast.loading(t("DashboardPayments.recurring.updatingCurrency"), {
      position: "bottom-right",
    });
    try {
      await updateRecurringPayment(recurringPayment.id, { token }, undefined, t);
      toast.success(t("DashboardPayments.recurring.currencyUpdated"), {
        id: toastId,
        position: "bottom-right",
      });
      setEditingCurrency(false);
      router.refresh();
    } catch (error) {
      toast.error(t("DashboardPayments.recurring.currencyUpdateFailed"), {
        id: toastId,
        description:
          error instanceof Error
            ? error.message
            : t("DashboardPayments.recurring.paymentUpdateFailed"),
        position: "bottom-right",
      });
    } finally {
      setSavingCurrency(false);
    }
  };

  const closeCurrencyModal = () => {
    setSelectedToken(recurringPayment.token);
    setCurrencyValidationError(null);
    setEditingCurrency(false);
  };

  const submitAmount = async () => {
    if (controlsDisabled) {
      return;
    }
    const amount = selectedAmount.trim();
    if (!amountIsValid(amount)) {
      setAmountValidationError(t("DashboardPayments.recurring.invalidAmount"));
      return;
    }
    if (amount === recurringPayment.amount) {
      setAmountValidationError(t("DashboardPayments.recurring.alreadySet", { value: amountLabel }));
      return;
    }

    setAmountValidationError(null);
    setSavingAmount(true);
    const toastId = toast.loading(t("DashboardPayments.recurring.updatingAmount"), {
      position: "bottom-right",
    });
    try {
      await updateRecurringPayment(recurringPayment.id, { amount }, undefined, t);
      toast.success(t("DashboardPayments.recurring.amountUpdated"), {
        id: toastId,
        position: "bottom-right",
      });
      setEditingAmount(false);
      router.refresh();
    } catch (error) {
      toast.error(t("DashboardPayments.recurring.amountUpdateFailed"), {
        id: toastId,
        description:
          error instanceof Error
            ? error.message
            : t("DashboardPayments.recurring.paymentUpdateFailed"),
        position: "bottom-right",
      });
    } finally {
      setSavingAmount(false);
    }
  };

  const closeAmountModal = () => {
    setSelectedAmount(recurringPayment.amount);
    setAmountValidationError(null);
    setEditingAmount(false);
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
                {amountLabel}
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
            disabled={
              savingWallet ||
              savingReceivingAccount ||
              savingBillingInterval ||
              savingCurrency ||
              savingAmount
            }
            onEdit={() => {
              setSelectedAmount(recurringPayment.amount);
              setAmountValidationError(null);
              setEditingAmount(true);
            }}
            onAction={(action) => void submitAction(action)}
            onCancel={() => setCancelConfirmOpen(true)}
          />
        </div>

        <RecurringPaymentLifecycleBand status={recurringPayment.status} actionError={actionError} />

        <div className="grid items-start gap-6 lg:grid-cols-2">
          <section className="space-y-3">
            <h3 className="text-sm font-medium text-primary">
              {t("DashboardPayments.recurring.detailPaymentSection")}
            </h3>
            <div className="rounded-lg border border-border-default bg-surface-raised px-4">
              <div className="divide-y divide-border-default">
                <DetailRow label={t("DashboardPayments.status")}>
                  <RecurringPaymentStatusBadge status={recurringPayment.status} />
                </DetailRow>
                <div className="flex min-h-12 items-center justify-between gap-4 py-3">
                  <span className="shrink-0 text-sm text-secondary">
                    {t("DashboardPayments.recurring.amount")}
                  </span>
                  <span className="flex min-w-0 flex-wrap items-center justify-end gap-2 text-right text-sm font-medium text-primary">
                    <TokenMark
                      mint={recurringPayment.token}
                      symbol={resolvedToken.tokenName}
                      logoUrl={resolvedToken.metadataImageUrl}
                      size="xs"
                    />
                    <span>{amountLabel}</span>
                    {isEditable ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={controlsDisabled}
                        iconLeft={<PencilIcon className="size-4" />}
                        onClick={() => {
                          setSelectedAmount(recurringPayment.amount);
                          setAmountValidationError(null);
                          setEditingAmount(true);
                        }}
                      >
                        {t("DashboardPayments.recurring.edit")}
                      </Button>
                    ) : null}
                  </span>
                </div>
                <div className="flex min-h-12 items-center justify-between gap-4 py-3">
                  <span className="shrink-0 text-sm text-secondary">
                    {t("DashboardPayments.recurring.currency")}
                  </span>
                  <span className="flex min-w-0 flex-wrap items-center justify-end gap-2 text-right text-sm font-medium text-primary">
                    <span>{currencyLabel}</span>
                    {isEditable ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={controlsDisabled || assetOptions.length === 0}
                        iconLeft={<PencilIcon className="size-4" />}
                        onClick={() => {
                          setSelectedToken(recurringPayment.token);
                          setCurrencyValidationError(null);
                          setEditingCurrency(true);
                        }}
                      >
                        {t("DashboardPayments.recurring.edit")}
                      </Button>
                    ) : null}
                  </span>
                </div>
                <div className="flex min-h-12 items-center justify-between gap-4 py-3">
                  <span className="shrink-0 text-sm text-secondary">
                    {t("DashboardPayments.recurring.billingInterval")}
                  </span>
                  <span className="flex min-w-0 flex-wrap items-center justify-end gap-2 text-right text-sm font-medium text-primary">
                    <span>{scheduleLabel}</span>
                    {isEditable ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={controlsDisabled}
                        iconLeft={<PencilIcon className="size-4" />}
                        onClick={() => {
                          setSelectedSchedulePreset(
                            schedulePresetForPeriodHours(recurringPayment.periodHours)
                          );
                          setSelectedCustomPeriodHours(String(recurringPayment.periodHours));
                          setBillingIntervalValidationError(null);
                          setEditingBillingInterval(true);
                        }}
                      >
                        {t("DashboardPayments.recurring.edit")}
                      </Button>
                    ) : null}
                  </span>
                </div>
                <DetailRow label={t("DashboardPayments.recurring.starts")}>
                  {formatOptionalTimestamp(recurringPayment.firstCollectionAt, t)}
                </DetailRow>
                <DetailRow label={t("DashboardPayments.recurring.nextPayment")}>
                  {formatOptionalTimestamp(recurringPayment.nextCollectionDueAt, t)}
                </DetailRow>
              </div>
            </div>
          </section>
          <section className="space-y-3">
            <h3 className="text-sm font-medium text-primary">
              {t("DashboardPayments.recurring.detailWalletsSection")}
            </h3>
            <div className="rounded-lg border border-border-default bg-surface-raised px-4">
              <div className="divide-y divide-border-default">
                <div className="flex min-h-12 items-center justify-between gap-4 py-3">
                  <span className="shrink-0 text-sm text-secondary">
                    {t("DashboardPayments.recurring.fundingWallet")}
                  </span>
                  <span className="flex min-w-0 flex-wrap items-center justify-end gap-2 text-right text-sm font-medium text-primary">
                    {wallet ? (
                      <EntityLink
                        href={`/dashboard/wallets/${encodeURIComponent(wallet.walletId)}`}
                      >
                        {sourceWalletLabel}
                      </EntityLink>
                    ) : (
                      <span className="min-w-0 truncate">{sourceWalletLabel}</span>
                    )}
                    {wallet ? (
                      <CopyableValue
                        value={wallet.publicKey}
                        label={shortenAddress(wallet.publicKey)}
                      />
                    ) : null}
                    {isEditable ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={controlsDisabled || wallets.length === 0}
                        iconLeft={<PencilIcon className="size-4" />}
                        onClick={() => {
                          setSelectedWalletId(recurringPayment.sourceWalletId);
                          setWalletValidationError(null);
                          setEditingWallet(true);
                        }}
                      >
                        {t("DashboardPayments.recurring.edit")}
                      </Button>
                    ) : null}
                  </span>
                </div>
                <div className="flex min-h-12 items-center justify-between gap-4 py-3">
                  <span className="shrink-0 text-sm text-secondary">
                    {t("DashboardPayments.recurring.receivingWallet")}
                  </span>
                  <span className="flex min-w-0 flex-wrap items-center justify-end gap-2 text-right text-sm font-medium text-primary">
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
                    {isEditable ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={controlsDisabled || counterpartyAccounts.length === 0}
                        iconLeft={<PencilIcon className="size-4" />}
                        onClick={() => {
                          setSelectedReceivingAccountId(recurringPayment.counterpartyAccountId);
                          setReceivingAccountValidationError(null);
                          setEditingReceivingAccount(true);
                        }}
                      >
                        {t("DashboardPayments.recurring.edit")}
                      </Button>
                    ) : null}
                  </span>
                </div>
                <DetailRow label={t("DashboardPayments.recurring.paymentReference")}>
                  <CopyableValue value={recurringPayment.id} label={paymentReferenceLabel} />
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
          isOpen={editingWallet}
          ariaLabel={t("DashboardPayments.recurring.editFundingWallet")}
          onClose={savingWallet ? undefined : closeFundingWalletModal}
          size="sm"
        >
          <form
            className="space-y-5 p-6"
            onSubmit={(event) => {
              event.preventDefault();
              void submitSourceWallet();
            }}
          >
            <div className="space-y-1">
              <h2 className="text-lg font-medium tracking-tight text-primary">
                {t("DashboardPayments.recurring.editFundingWallet")}
              </h2>
              <p className="text-sm text-secondary">
                {t("DashboardPayments.recurring.editFundingWalletDescription")}
              </p>
            </div>
            <Combobox
              label={t("DashboardPayments.recurring.fundingWallet")}
              value={selectedWalletId}
              onChange={(value) => {
                setSelectedWalletId(value);
                setWalletValidationError(null);
              }}
              options={wallets.map((entry) => ({
                value: entry.walletId,
                label: walletLabel(entry, entry.walletId),
                description: shortenAddress(entry.publicKey),
              }))}
              placeholder={t("DashboardPayments.recurring.selectFundingWallet")}
              searchPlaceholder={t("DashboardPayments.recurring.searchWallets")}
              icon={<WalletIcon />}
              disabled={savingWallet}
              validationError={walletValidationError ?? undefined}
              onEnterSelect={(value) => {
                setSelectedWalletId(value);
                setWalletValidationError(null);
                void submitSourceWallet(value);
              }}
            />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={savingWallet}
                onClick={closeFundingWalletModal}
              >
                {t("DashboardPayments.recurring.cancel")}
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={savingWallet}
                iconLeft={
                  savingWallet ? (
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
          isOpen={editingReceivingAccount}
          ariaLabel={t("DashboardPayments.recurring.editReceivingWallet")}
          onClose={savingReceivingAccount ? undefined : closeReceivingAccountModal}
          size="sm"
        >
          <form
            className="space-y-5 p-6"
            onSubmit={(event) => {
              event.preventDefault();
              void submitReceivingAccount();
            }}
          >
            <div className="space-y-1">
              <h2 className="text-lg font-medium tracking-tight text-primary">
                {t("DashboardPayments.recurring.editReceivingWallet")}
              </h2>
              <p className="text-sm text-secondary">
                {t("DashboardPayments.recurring.editReceivingWalletDescription")}
              </p>
            </div>
            <Combobox
              label={t("DashboardPayments.recurring.receivingWallet")}
              value={selectedReceivingAccountId}
              onChange={(value) => {
                setSelectedReceivingAccountId(value);
                setReceivingAccountValidationError(null);
              }}
              options={counterpartyAccounts.map((account) => {
                const address = accountAddress(account);
                return {
                  value: account.id,
                  label: accountLabel(account, account.id),
                  description: shortenAddress(address),
                };
              })}
              placeholder={t("DashboardPayments.recurring.selectReceivingWallet")}
              searchPlaceholder={t("DashboardPayments.recurring.searchWallets")}
              icon={<WalletIcon />}
              disabled={savingReceivingAccount}
              validationError={receivingAccountValidationError ?? undefined}
              onEnterSelect={(value) => {
                setSelectedReceivingAccountId(value);
                setReceivingAccountValidationError(null);
                void submitReceivingAccount(value);
              }}
            />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={savingReceivingAccount}
                onClick={closeReceivingAccountModal}
              >
                {t("DashboardPayments.recurring.cancel")}
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={savingReceivingAccount}
                iconLeft={
                  savingReceivingAccount ? (
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
          isOpen={editingAmount}
          ariaLabel={t("DashboardPayments.recurring.editAmount")}
          onClose={savingAmount ? undefined : closeAmountModal}
          size="sm"
        >
          <form
            className="space-y-5 p-6"
            onSubmit={(event) => {
              event.preventDefault();
              void submitAmount();
            }}
          >
            <div className="space-y-1">
              <h2 className="text-lg font-medium tracking-tight text-primary">
                {t("DashboardPayments.recurring.editAmount")}
              </h2>
              <p className="text-sm text-secondary">
                {t("DashboardPayments.recurring.editAmountDescription")}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="recurring-payment-edit-amount">
                {t("DashboardPayments.recurring.amount")}
              </Label>
              <Input
                id="recurring-payment-edit-amount"
                inputMode="decimal"
                value={selectedAmount}
                disabled={savingAmount}
                aria-invalid={Boolean(amountValidationError)}
                onChange={(event) => {
                  setSelectedAmount(event.currentTarget.value);
                  setAmountValidationError(null);
                }}
                placeholder="0.00"
              />
              {amountValidationError ? (
                <p className="text-sm text-error">{amountValidationError}</p>
              ) : (
                <p className="text-sm text-tertiary">{currencyLabel}</p>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={savingAmount}
                onClick={closeAmountModal}
              >
                {t("DashboardPayments.recurring.cancel")}
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={savingAmount}
                iconLeft={
                  savingAmount ? (
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
          isOpen={editingBillingInterval}
          ariaLabel={t("DashboardPayments.recurring.editBillingInterval")}
          onClose={savingBillingInterval ? undefined : closeBillingIntervalModal}
          size="sm"
        >
          <form
            className="space-y-5 p-6"
            onSubmit={(event) => {
              event.preventDefault();
              void submitBillingInterval();
            }}
          >
            <div className="space-y-1">
              <h2 className="text-lg font-medium tracking-tight text-primary">
                {t("DashboardPayments.recurring.editBillingInterval")}
              </h2>
              <p className="text-sm text-secondary">
                {t("DashboardPayments.recurring.editBillingIntervalDescription")}
              </p>
            </div>
            <Combobox
              label={t("DashboardPayments.recurring.billingInterval")}
              value={selectedSchedulePreset}
              onChange={(value) => {
                setSelectedSchedulePreset(value as SchedulePreset);
                setBillingIntervalValidationError(null);
              }}
              options={getSchedulePresets(t)}
              searchable={false}
              icon={<RepeatIcon />}
              disabled={savingBillingInterval}
            />
            {selectedSchedulePreset === "custom" ? (
              <div className="space-y-2">
                <Label htmlFor="recurring-payment-edit-period-hours">
                  {t("DashboardPayments.recurring.intervalHours")}
                </Label>
                <Input
                  id="recurring-payment-edit-period-hours"
                  inputMode="numeric"
                  value={selectedCustomPeriodHours}
                  disabled={savingBillingInterval}
                  aria-invalid={Boolean(billingIntervalValidationError)}
                  onChange={(event) => {
                    setSelectedCustomPeriodHours(event.currentTarget.value);
                    setBillingIntervalValidationError(null);
                  }}
                  placeholder="24"
                />
                {billingIntervalValidationError ? (
                  <p className="text-sm text-error">{billingIntervalValidationError}</p>
                ) : null}
              </div>
            ) : billingIntervalValidationError ? (
              <p className="text-sm text-error">{billingIntervalValidationError}</p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={savingBillingInterval}
                onClick={closeBillingIntervalModal}
              >
                {t("DashboardPayments.recurring.cancel")}
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={savingBillingInterval}
                iconLeft={
                  savingBillingInterval ? (
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
          isOpen={editingCurrency}
          ariaLabel={t("DashboardPayments.recurring.editCurrency")}
          onClose={savingCurrency ? undefined : closeCurrencyModal}
          size="sm"
        >
          <form
            className="space-y-5 p-6"
            onSubmit={(event) => {
              event.preventDefault();
              void submitCurrency();
            }}
          >
            <div className="space-y-1">
              <h2 className="text-lg font-medium tracking-tight text-primary">
                {t("DashboardPayments.recurring.editCurrency")}
              </h2>
              <p className="text-sm text-secondary">
                {t("DashboardPayments.recurring.editCurrencyDescription")}
              </p>
            </div>
            <Combobox
              label={t("DashboardPayments.recurring.currency")}
              value={selectedToken}
              onChange={(value) => {
                setSelectedToken(value);
                setCurrencyValidationError(null);
              }}
              options={assetOptions}
              placeholder={
                assetOptions.length === 0
                  ? t("DashboardPayments.recurring.noTokenBalances")
                  : t("DashboardPayments.recurring.selectCurrency")
              }
              searchPlaceholder={t("DashboardPayments.ramps.searchCurrencies")}
              icon={<CreditCardIcon />}
              disabled={savingCurrency || assetOptions.length === 0}
              validationError={currencyValidationError ?? undefined}
              onEnterSelect={(value) => {
                setSelectedToken(value);
                setCurrencyValidationError(null);
                void submitCurrency(value);
              }}
            />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={savingCurrency}
                onClick={closeCurrencyModal}
              >
                {t("DashboardPayments.recurring.cancel")}
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={savingCurrency}
                iconLeft={
                  savingCurrency ? (
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
