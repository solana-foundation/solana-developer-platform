"use client";

import {
  type CounterpartyAccount,
  type PaymentRecurringPayment,
  type PaymentRecurringPaymentStatus,
  type PaymentSubscriptionCollectionAttempt,
  type PaymentSubscriptionCollectionAttemptStatus,
  type PaymentsDashboardWallet,
  WELL_KNOWN_TOKEN_BY_MINT,
} from "@sdp/types";
import {
  AlertCircleIcon,
  BanIcon,
  ChevronDownIcon,
  CopyIcon,
  CreditCardIcon,
  ExternalLinkIcon,
  InfoIcon,
  Loader2Icon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  RepeatIcon,
  RotateCcwIcon,
  WalletIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type KeyboardEvent, type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDisplayAmount, formatTimestamp, shortenAddress } from "../payments-overview.utils";
import { getDevnetExplorerUrl } from "../payments-workspace.data";
import { walletBalanceAssetOptions } from "../ramps/wallet-options";
import {
  type RecurringPaymentAction,
  runRecurringPaymentAction,
  updateRecurringPayment,
} from "./recurring-payments.data";

const STATUS_LABELS = {
  pending_activation: "Pending activation",
  activating: "Activating",
  active: "Active",
  updating: "Updating",
  canceling: "Canceling",
  resuming: "Resuming",
  paused: "Paused",
  canceled: "Canceled",
  expired: "Expired",
} as const satisfies Record<PaymentRecurringPaymentStatus, string>;

const STATUS_VARIANTS = {
  pending_activation: "warning",
  activating: "warning",
  active: "success",
  updating: "warning",
  canceling: "warning",
  resuming: "warning",
  paused: "info",
  canceled: "danger",
  expired: "danger",
} as const satisfies Record<PaymentRecurringPaymentStatus, BadgeVariant>;

const COLLECTION_STATUS_LABELS = {
  pending: "Pending",
  processing: "Processing",
  confirmed: "Collected",
  failed: "Failed",
  skipped: "Skipped",
} as const satisfies Record<PaymentSubscriptionCollectionAttemptStatus, string>;

const COLLECTION_STATUS_VARIANTS = {
  pending: "warning",
  processing: "info",
  confirmed: "success",
  failed: "danger",
  skipped: "default",
} as const satisfies Record<PaymentSubscriptionCollectionAttemptStatus, BadgeVariant>;

const COLLECTION_ATTEMPTED_COLUMN_CLASS = "hidden @4xl/collection-history:table-cell";
const COLLECTION_TRANSFER_COLUMN_CLASS = "hidden @6xl/collection-history:table-cell";

type RecurringPaymentWalletView = PaymentsDashboardWallet;

interface RecurringPaymentCounterpartyView {
  id: string;
  displayName: string;
}

interface RecurringPaymentsWorkspaceProps {
  initialRecurringPayments: PaymentRecurringPayment[];
  initialTotal: number;
  initialError?: string;
  lookupError?: string;
  wallets: RecurringPaymentWalletView[];
  counterparties: RecurringPaymentCounterpartyView[];
}

interface RecurringPaymentDetailWorkspaceProps {
  recurringPayment: PaymentRecurringPayment;
  wallet: RecurringPaymentWalletView | null;
  wallets: RecurringPaymentWalletView[];
  counterpartyAccounts: CounterpartyAccount[];
  counterpartyLabel: string;
  amountLabel: string;
  currencyLabel: string;
  collectionAttempts: PaymentSubscriptionCollectionAttempt[];
  collectionAttemptsTotal: number;
  collectionAttemptsError?: string;
}

function RecurringPaymentStatusBadge({ status }: { status: PaymentRecurringPaymentStatus }) {
  return <Badge variant={STATUS_VARIANTS[status]}>{STATUS_LABELS[status]}</Badge>;
}

function formatOptionalTimestamp(value: string | null | undefined): string {
  return value ? formatTimestamp(value) : "Not set";
}

function formatPeriodHours(periodHours: number): string {
  if (periodHours === 24) {
    return "Every day";
  }
  if (periodHours % 168 === 0) {
    const weeks = periodHours / 168;
    return weeks === 1 ? "Every week" : `Every ${weeks} weeks`;
  }
  if (periodHours % 24 === 0) {
    const days = periodHours / 24;
    return days === 1 ? "Every day" : `Every ${days} days`;
  }
  return periodHours === 1 ? "Every hour" : `Every ${periodHours} hours`;
}

type SchedulePreset = "24" | "168" | "720" | "custom";

const SCHEDULE_PRESETS = [
  { value: "24", label: "Every day", description: "Collect once per day." },
  { value: "168", label: "Every week", description: "Collect once per week." },
  { value: "720", label: "Every 30 days", description: "Collect about once per month." },
  { value: "custom", label: "Custom", description: "Enter an interval in hours." },
] as const satisfies readonly {
  value: SchedulePreset;
  label: string;
  description: string;
}[];

function schedulePresetForPeriodHours(periodHours: number): SchedulePreset {
  return SCHEDULE_PRESETS.some((preset) => preset.value === String(periodHours))
    ? (String(periodHours) as SchedulePreset)
    : "custom";
}

function parsePeriodHours(
  schedulePreset: SchedulePreset,
  customPeriodHours: string
): number | null {
  const rawValue = schedulePreset === "custom" ? customPeriodHours : schedulePreset;
  if (!/^\d+$/.test(rawValue.trim())) {
    return null;
  }
  const value = Number(rawValue);
  return Number.isInteger(value) && value > 0 && value <= 24 * 365 ? value : null;
}

function amountIsValid(value: string): boolean {
  return /^\d+(\.\d{1,9})?$/.test(value.trim()) && Number(value) > 0;
}

function resolveTokenLabel(token: string, wallets: RecurringPaymentWalletView[]): string {
  const knownToken = WELL_KNOWN_TOKEN_BY_MINT.get(token);
  if (knownToken) {
    return knownToken.symbol;
  }

  for (const wallet of wallets) {
    const balance = wallet.balances?.find((entry) => entry.mint === token);
    if (balance?.token) {
      return balance.token;
    }
  }

  return token.length <= 12 ? token : shortenAddress(token);
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <span className="shrink-0 text-sm text-text-medium">{label}</span>
      <span className="min-w-0 break-all text-right text-sm font-medium text-text-extra-high">
        {children}
      </span>
    </div>
  );
}

function CopyableValue({
  value,
  label,
  empty = "Not set",
}: {
  value: string | null;
  label?: string;
  empty?: string;
}) {
  if (!value) {
    return <span className="text-text-low">{empty}</span>;
  }

  return (
    <span className="inline-flex max-w-full items-center justify-end gap-2">
      <span
        className="min-w-0 truncate font-mono text-xs text-text-extra-high"
        title={label ?? value}
      >
        {label ?? value}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Copy value"
        onClick={() => {
          void navigator.clipboard.writeText(value);
          toast.success("Copied");
        }}
      >
        <CopyIcon />
      </Button>
    </span>
  );
}

function CollectionStatusBadge({ status }: { status: PaymentSubscriptionCollectionAttemptStatus }) {
  return (
    <Badge variant={COLLECTION_STATUS_VARIANTS[status]}>{COLLECTION_STATUS_LABELS[status]}</Badge>
  );
}

function ExplorerValue({ value }: { value: string | null }) {
  if (!value) {
    return <span className="text-text-low">Not set</span>;
  }

  return (
    <span className="inline-flex max-w-full items-center gap-1.5">
      <CopyableValue value={value} label={shortenAddress(value)} />
      <Button asChild variant="ghost" size="icon-xs" aria-label="Open signature">
        <a href={getDevnetExplorerUrl(value)} target="_blank" rel="noreferrer">
          <ExternalLinkIcon />
        </a>
      </Button>
    </span>
  );
}

function RecurringPaymentCollectionHistory({
  attempts,
  total,
  error,
  wallets,
}: {
  attempts: PaymentSubscriptionCollectionAttempt[];
  total: number;
  error?: string;
  wallets: RecurringPaymentWalletView[];
}) {
  const attemptsLabel =
    total > attempts.length
      ? `Showing ${attempts.length} of ${total} attempts`
      : attempts.length === 1
        ? "1 attempt"
        : `${attempts.length} attempts`;

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-text-extra-high">Collection history</h3>
        {attempts.length > 0 ? (
          <span className="text-xs text-text-low">{attemptsLabel}</span>
        ) : null}
      </div>
      <div className="@container/collection-history rounded-xl border border-border-light">
        {error ? (
          <div role="alert" className="p-4 text-sm text-status-error-text">
            Unable to load collection history: {error}
          </div>
        ) : attempts.length === 0 ? (
          <div className="p-4 text-sm text-text-medium">
            No collection attempts yet. The next scheduled collection is shown above.
          </div>
        ) : (
          <div className="overflow-hidden">
            <Table className="[&_table]:w-full [&_table]:min-w-0 [&_table]:table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[28%] @4xl/collection-history:w-[20%] @6xl/collection-history:w-[17%] @7xl/collection-history:w-[15%]">
                    Due
                  </TableHead>
                  <TableHead
                    className={`${COLLECTION_ATTEMPTED_COLUMN_CLASS} w-[20%] @6xl/collection-history:w-[16%] @7xl/collection-history:w-[15%]`}
                  >
                    Attempted
                  </TableHead>
                  <TableHead className="w-[25%] @4xl/collection-history:w-[21%] @6xl/collection-history:w-[17%] @7xl/collection-history:w-[16%]">
                    Amount
                  </TableHead>
                  <TableHead className="w-[23%] @4xl/collection-history:w-[18%] @6xl/collection-history:w-[15%] @7xl/collection-history:w-[14%]">
                    Status
                  </TableHead>
                  <TableHead
                    className={`${COLLECTION_TRANSFER_COLUMN_CLASS} w-[22%] @7xl/collection-history:w-[18%]`}
                  >
                    Transfer
                  </TableHead>
                  <TableHead className="w-[24%] @4xl/collection-history:w-[21%] @6xl/collection-history:w-[18%] @7xl/collection-history:w-[22%]">
                    Explorer
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {attempts.map((attempt) => (
                  <TableRow key={attempt.id}>
                    <TableCell className="whitespace-nowrap text-sm">
                      <span className="block truncate">{formatTimestamp(attempt.dueAt)}</span>
                    </TableCell>
                    <TableCell
                      className={`${COLLECTION_ATTEMPTED_COLUMN_CLASS} whitespace-nowrap text-sm text-text-medium`}
                    >
                      <span className="block truncate">
                        {attempt.attemptedAt ? formatTimestamp(attempt.attemptedAt) : "Not set"}
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm font-medium">
                      <span className="block truncate">
                        {formatDisplayAmount(
                          attempt.amount,
                          resolveTokenLabel(attempt.token, wallets)
                        )}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="space-y-1">
                        <CollectionStatusBadge status={attempt.status} />
                        {attempt.error ? (
                          <p className="max-w-[14rem] truncate text-xs text-status-error-text">
                            {attempt.error}
                          </p>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className={COLLECTION_TRANSFER_COLUMN_CLASS}>
                      <CopyableValue
                        value={attempt.transferId}
                        label={attempt.transferId ? shortenAddress(attempt.transferId) : undefined}
                      />
                    </TableCell>
                    <TableCell>
                      <ExplorerValue value={attempt.signature} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}

function walletLabel(wallet: RecurringPaymentWalletView | null, fallbackWalletId: string): string {
  if (!wallet) {
    return fallbackWalletId;
  }
  return wallet.label || shortenAddress(wallet.publicKey);
}

function accountAddress(account: CounterpartyAccount | null): string {
  const address = account?.details.address;
  return typeof address === "string" ? address : "";
}

function accountLabel(account: CounterpartyAccount | null, fallbackAccountId: string): string {
  if (!account) {
    return fallbackAccountId;
  }
  return account.label || shortenAddress(accountAddress(account));
}

function isDueNow(value: string | null): boolean {
  return Boolean(value && Date.parse(value) <= Date.now());
}

function actionSuccessLabel(action: RecurringPaymentAction): string {
  switch (action) {
    case "activate":
      return "Recurring payment activated.";
    case "collect":
      return "Recurring payment collection submitted.";
    case "cancel":
      return "Recurring payment canceled.";
    case "resume":
      return "Recurring payment resumed.";
  }
}

function actionFailureTitle(action: RecurringPaymentAction): string {
  switch (action) {
    case "activate":
      return "Activation failed";
    case "collect":
      return "Collection failed";
    case "cancel":
      return "Cancellation failed";
    case "resume":
      return "Resume failed";
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
    info: "border-border-light bg-[var(--sdp-color-info-bg)] text-[color:var(--sdp-color-info-text)]",
    warning: "border-border-light bg-status-warning-bg text-status-warning-text",
    danger: "border-status-error-border bg-status-error-bg text-status-error-text",
  }[variant];
  const Icon = variant === "danger" ? AlertCircleIcon : InfoIcon;

  return (
    <div className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-sm ${styles}`}>
      <Icon className="size-4 shrink-0 self-center" />
      <div className="min-w-0 space-y-1">
        <p className="font-medium">{title}</p>
        <div className="text-text-extra-high">{children}</div>
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

function disabledActionLabel(status: PaymentRecurringPaymentStatus): string | null {
  switch (status) {
    case "activating":
      return "Activating";
    case "updating":
      return "Updating";
    case "canceling":
      return "Canceling";
    case "resuming":
      return "Resuming";
    default:
      return null;
  }
}

function primaryDetailAction(
  status: PaymentRecurringPaymentStatus,
  dueNow: boolean,
  error: DetailActionError | null
): DetailAction | null {
  if (status === "pending_activation") {
    return {
      action: "activate",
      label: error?.action === "activate" ? "Retry activation" : "Activate",
    };
  }
  if (dueNow) {
    return {
      action: "collect",
      label: error?.action === "collect" ? "Retry collection" : "Collect now",
    };
  }
  if (status === "canceled") {
    return {
      action: "resume",
      label: error?.action === "resume" ? "Retry resume" : "Resume",
    };
  }
  return null;
}

function secondaryDetailAction(
  status: PaymentRecurringPaymentStatus,
  error: DetailActionError | null
): DetailAction | null {
  if (status !== "active") {
    return null;
  }
  return {
    action: "cancel",
    label: error?.action === "cancel" ? "Retry cancellation" : "Cancel",
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
  const disabledLabel = disabledActionLabel(status);
  const primaryAction = primaryDetailAction(status, dueNow, actionError);
  const secondaryAction = secondaryDetailAction(status, actionError);
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
          Actions
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuItem onSelect={onEdit} disabled={!editable || actionsDisabled}>
          <PencilIcon className="size-4" />
          <span>Edit payment</span>
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
              className="items-start text-status-error-text focus:text-status-error-text"
            >
              {pendingAction === secondaryAction.action ? (
                <Loader2Icon className="mt-0.5 size-4 animate-spin" />
              ) : (
                <BanIcon className="mt-0.5 size-4" />
              )}
              <span className="grid gap-0.5">
                <span>{secondaryAction.label}</span>
                <span className="text-xs font-normal text-status-error-text">
                  Stop future collections
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
  if (actionError) {
    return (
      <ActionBand variant="danger" title={actionFailureTitle(actionError.action)}>
        <div className="flex flex-wrap items-center gap-2">
          <span>{actionError.message}</span>
          <CopyableValue value={actionError.message} label="Copy error" />
        </div>
      </ActionBand>
    );
  }
  if (status === "pending_activation") {
    return (
      <ActionBand variant="info" title="Ready to activate">
        Creates the subscription and schedules the first payment.
      </ActionBand>
    );
  }
  if (status === "paused" || status === "expired") {
    return (
      <ActionBand variant="warning" title="Lifecycle action unavailable">
        This recurring payment cannot be changed from its current status.
      </ActionBand>
    );
  }
  return null;
}

function canEditRecurringPayment(status: PaymentRecurringPaymentStatus): boolean {
  return status === "pending_activation" || status === "active";
}

export function RecurringPaymentsWorkspace({
  initialRecurringPayments,
  initialTotal,
  initialError,
  lookupError,
  wallets,
  counterparties,
}: RecurringPaymentsWorkspaceProps) {
  const router = useRouter();

  const walletById = useMemo(
    () => new Map(wallets.map((wallet) => [wallet.walletId, wallet])),
    [wallets]
  );
  const counterpartyById = useMemo(
    () => new Map(counterparties.map((counterparty) => [counterparty.id, counterparty])),
    [counterparties]
  );

  const countLabel =
    initialTotal === 1 ? "1 recurring payment" : `${initialTotal} recurring payments`;

  const getWalletLabel = (recurringPayment: PaymentRecurringPayment) => {
    const wallet = walletById.get(recurringPayment.sourceWalletId);
    return (
      wallet?.label || (wallet ? shortenAddress(wallet.publicKey) : recurringPayment.sourceWalletId)
    );
  };
  const getCounterpartyLabel = (recurringPayment: PaymentRecurringPayment) =>
    counterpartyById.get(recurringPayment.counterpartyId)?.displayName ??
    "Counterparty unavailable";
  const getAmountLabel = (recurringPayment: PaymentRecurringPayment) =>
    formatDisplayAmount(
      recurringPayment.amount,
      resolveTokenLabel(recurringPayment.token, wallets)
    );

  return (
    <div className="h-full min-h-0 w-full px-3 pt-6 pb-5 md:px-6 md:pb-6">
      <Card className="flex h-full min-h-0 flex-col">
        <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1.5">
            <CardTitle>Recurring payments</CardTitle>
            <CardDescription>{countLabel}</CardDescription>
          </div>
          <Button asChild size="sm">
            <Link href="/dashboard/payments/recurring/create">
              <PlusIcon className="size-4" />
              Create recurring payment
            </Link>
          </Button>
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col">
          {initialError ? (
            <div
              role="alert"
              className="border border-status-error-border bg-status-error-bg p-4 text-sm text-status-error-text"
            >
              <p className="font-medium">Unable to load recurring payments</p>
              <p className="mt-1">{initialError}</p>
            </div>
          ) : initialRecurringPayments.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border-medium py-16 text-center">
              <RepeatIcon className="h-10 w-10 text-text-extra-low" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-text-extra-high">
                  No recurring payments yet.
                </p>
                <p className="text-sm text-text-low">
                  Created recurring payment records will appear here.
                </p>
              </div>
              <Button asChild size="sm">
                <Link href="/dashboard/payments/recurring/create">
                  <PlusIcon className="size-4" />
                  Create recurring payment
                </Link>
              </Button>
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-hidden">
              {lookupError ? (
                <p className="mb-3 text-sm text-status-warning-text">{lookupError}</p>
              ) : null}
              <Table className="w-full [&_table]:table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[34%] md:w-[26%] lg:w-[21%] xl:w-[18%]">
                      Status
                    </TableHead>
                    <TableHead className="w-[26%] md:w-[22%] lg:w-[20%] xl:w-[18%]">
                      Amount
                    </TableHead>
                    <TableHead className="w-[40%] md:w-[34%] lg:w-[31%] xl:w-[24%]">
                      Counterparty
                    </TableHead>
                    <TableHead className="hidden lg:table-cell lg:w-[28%] xl:w-[22%]">
                      Funding wallet
                    </TableHead>
                    <TableHead className="hidden xl:table-cell xl:w-[18%]">Interval</TableHead>
                    <TableHead className="hidden md:table-cell md:w-[18%] xl:hidden 2xl:table-cell 2xl:w-[18%]">
                      Next payment
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {initialRecurringPayments.map((recurringPayment) => (
                    <TableRow
                      key={recurringPayment.id}
                      role="button"
                      tabIndex={0}
                      onClick={() =>
                        router.push(
                          `/dashboard/payments/recurring/${encodeURIComponent(recurringPayment.id)}`
                        )
                      }
                      onKeyDown={(event: KeyboardEvent) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          router.push(
                            `/dashboard/payments/recurring/${encodeURIComponent(recurringPayment.id)}`
                          );
                        }
                      }}
                      className="cursor-pointer"
                    >
                      <TableCell>
                        <RecurringPaymentStatusBadge status={recurringPayment.status} />
                      </TableCell>
                      <TableCell className="font-medium">
                        <span className="block truncate">{getAmountLabel(recurringPayment)}</span>
                      </TableCell>
                      <TableCell className="text-sm text-text-medium">
                        <span className="block truncate">
                          {getCounterpartyLabel(recurringPayment)}
                        </span>
                      </TableCell>
                      <TableCell className="hidden text-sm text-text-medium lg:table-cell">
                        <span className="block truncate">{getWalletLabel(recurringPayment)}</span>
                      </TableCell>
                      <TableCell className="hidden text-sm text-text-medium xl:table-cell">
                        {formatPeriodHours(recurringPayment.periodHours)}
                      </TableCell>
                      <TableCell className="hidden text-sm text-text-medium md:table-cell xl:hidden 2xl:table-cell">
                        {formatOptionalTimestamp(recurringPayment.nextCollectionDueAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: detail editing intentionally centralizes lifecycle and modal state in one workspace.
export function RecurringPaymentDetailWorkspace({
  recurringPayment,
  wallet,
  wallets,
  counterpartyAccounts,
  counterpartyLabel,
  amountLabel,
  currencyLabel,
  collectionAttempts,
  collectionAttemptsTotal,
  collectionAttemptsError,
}: RecurringPaymentDetailWorkspaceProps) {
  const router = useRouter();
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
  const scheduleLabel = formatPeriodHours(recurringPayment.periodHours);
  const paymentReferenceLabel = shortenAddress(recurringPayment.id);
  const sourceWalletLabel = walletLabel(wallet, recurringPayment.sourceWalletId);
  const assetOptions = walletBalanceAssetOptions(wallet, {});
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
    const toastId = toast.loading("Updating recurring payment.", { position: "bottom-right" });
    try {
      await runRecurringPaymentAction(recurringPayment.id, action);
      toast.success(actionSuccessLabel(action), { id: toastId, position: "bottom-right" });
      router.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Recurring payment action failed.";
      setActionError({ action, message });
      toast.error(actionFailureTitle(action), {
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
      setWalletValidationError("Select a funding wallet.");
      return;
    }
    if (walletId === recurringPayment.sourceWalletId) {
      setWalletValidationError(`${sourceWalletLabel} is already the funding wallet.`);
      return;
    }

    setWalletValidationError(null);
    setSavingWallet(true);
    const toastId = toast.loading("Updating funding wallet.", { position: "bottom-right" });
    try {
      await updateRecurringPayment(recurringPayment.id, { sourceWalletId: walletId });
      toast.success("Funding wallet updated.", { id: toastId, position: "bottom-right" });
      setEditingWallet(false);
      router.refresh();
    } catch (error) {
      toast.error("Funding wallet update failed", {
        id: toastId,
        description: error instanceof Error ? error.message : "Recurring payment update failed.",
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
      setReceivingAccountValidationError("Select a receiving wallet.");
      return;
    }
    if (accountId === recurringPayment.counterpartyAccountId) {
      setReceivingAccountValidationError(
        `${receivingAccountLabel} is already the receiving wallet.`
      );
      return;
    }

    setReceivingAccountValidationError(null);
    setSavingReceivingAccount(true);
    const toastId = toast.loading("Updating receiving wallet.", { position: "bottom-right" });
    try {
      await updateRecurringPayment(recurringPayment.id, { counterpartyAccountId: accountId });
      toast.success("Receiving wallet updated.", { id: toastId, position: "bottom-right" });
      setEditingReceivingAccount(false);
      router.refresh();
    } catch (error) {
      toast.error("Receiving wallet update failed", {
        id: toastId,
        description: error instanceof Error ? error.message : "Recurring payment update failed.",
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
      setBillingIntervalValidationError("Enter a whole number of hours between 1 and 8760.");
      return;
    }
    if (periodHours === recurringPayment.periodHours) {
      setBillingIntervalValidationError(`${formatPeriodHours(periodHours)} is already set.`);
      return;
    }

    setBillingIntervalValidationError(null);
    setSavingBillingInterval(true);
    const toastId = toast.loading("Updating billing interval.", { position: "bottom-right" });
    try {
      await updateRecurringPayment(recurringPayment.id, { periodHours });
      toast.success("Billing interval updated.", { id: toastId, position: "bottom-right" });
      setEditingBillingInterval(false);
      router.refresh();
    } catch (error) {
      toast.error("Billing interval update failed", {
        id: toastId,
        description: error instanceof Error ? error.message : "Recurring payment update failed.",
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
      setCurrencyValidationError("Select a currency.");
      return;
    }
    if (token === recurringPayment.token) {
      setCurrencyValidationError(`${resolveTokenLabel(token, wallets)} is already the currency.`);
      return;
    }

    setCurrencyValidationError(null);
    setSavingCurrency(true);
    const toastId = toast.loading("Updating currency.", { position: "bottom-right" });
    try {
      await updateRecurringPayment(recurringPayment.id, { token });
      toast.success("Currency updated.", { id: toastId, position: "bottom-right" });
      setEditingCurrency(false);
      router.refresh();
    } catch (error) {
      toast.error("Currency update failed", {
        id: toastId,
        description: error instanceof Error ? error.message : "Recurring payment update failed.",
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
      setAmountValidationError("Enter an amount greater than zero.");
      return;
    }
    if (amount === recurringPayment.amount) {
      setAmountValidationError(`${amountLabel} is already set.`);
      return;
    }

    setAmountValidationError(null);
    setSavingAmount(true);
    const toastId = toast.loading("Updating amount.", { position: "bottom-right" });
    try {
      await updateRecurringPayment(recurringPayment.id, { amount });
      toast.success("Amount updated.", { id: toastId, position: "bottom-right" });
      setEditingAmount(false);
      router.refresh();
    } catch (error) {
      toast.error("Amount update failed", {
        id: toastId,
        description: error instanceof Error ? error.message : "Recurring payment update failed.",
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

  return (
    <div className="h-full min-h-0 w-full overflow-auto px-3 pt-6 pb-5 md:px-6 md:pb-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <h2 className="text-3xl font-medium tracking-tight text-text-extra-high">
              Recurring payment
            </h2>
            <p className="truncate text-sm text-text-medium">
              {counterpartyLabel} · {amountLabel} · {scheduleLabel}
            </p>
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

        <div className="rounded-xl border border-border-light px-4">
          <div className="divide-y divide-border-light">
            <DetailRow label="Status">
              <RecurringPaymentStatusBadge status={recurringPayment.status} />
            </DetailRow>
            <div className="flex items-start justify-between gap-4 py-3">
              <span className="shrink-0 text-sm text-text-medium">Amount</span>
              <span className="flex min-w-0 flex-wrap items-center justify-end gap-2 text-right text-sm font-medium text-text-extra-high">
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
                    Edit
                  </Button>
                ) : null}
              </span>
            </div>
            <div className="flex items-start justify-between gap-4 py-3">
              <span className="shrink-0 text-sm text-text-medium">Funding wallet</span>
              <span className="flex min-w-0 flex-wrap items-center justify-end gap-2 text-right text-sm font-medium text-text-extra-high">
                {wallet ? (
                  <Link
                    href={`/dashboard/wallets/${encodeURIComponent(wallet.walletId)}`}
                    className="min-w-0 truncate underline-offset-4 hover:underline focus-visible:underline"
                  >
                    {sourceWalletLabel}
                  </Link>
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
                    Edit
                  </Button>
                ) : null}
              </span>
            </div>
            <div className="flex items-start justify-between gap-4 py-3">
              <span className="shrink-0 text-sm text-text-medium">Receiving wallet</span>
              <span className="flex min-w-0 flex-wrap items-center justify-end gap-2 text-right text-sm font-medium text-text-extra-high">
                <span className="min-w-0 truncate">{receivingAccountLabel}</span>
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
                    Edit
                  </Button>
                ) : null}
              </span>
            </div>
            <DetailRow label="Starts">
              {formatOptionalTimestamp(recurringPayment.firstCollectionAt)}
            </DetailRow>
            <DetailRow label="Next payment">
              {formatOptionalTimestamp(recurringPayment.nextCollectionDueAt)}
            </DetailRow>
            <div className="flex items-start justify-between gap-4 py-3">
              <span className="shrink-0 text-sm text-text-medium">Billing interval</span>
              <span className="flex min-w-0 flex-wrap items-center justify-end gap-2 text-right text-sm font-medium text-text-extra-high">
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
                    Edit
                  </Button>
                ) : null}
              </span>
            </div>
            <div className="flex items-start justify-between gap-4 py-3">
              <span className="shrink-0 text-sm text-text-medium">Currency</span>
              <span className="flex min-w-0 flex-wrap items-center justify-end gap-2 text-right text-sm font-medium text-text-extra-high">
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
                    Edit
                  </Button>
                ) : null}
              </span>
            </div>
            <DetailRow label="Payment reference">
              <CopyableValue value={recurringPayment.id} label={paymentReferenceLabel} />
            </DetailRow>
            <DetailRow label="Metadata">
              {recurringPayment.metadataUri ? (
                <a
                  href={recurringPayment.metadataUri}
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-4"
                >
                  Open metadata
                </a>
              ) : (
                <span className="text-text-low">Not set</span>
              )}
            </DetailRow>
            <DetailRow label="Created">{formatTimestamp(recurringPayment.createdAt)}</DetailRow>
            <DetailRow label="Updated">{formatTimestamp(recurringPayment.updatedAt)}</DetailRow>
          </div>
        </div>

        <Modal
          isOpen={editingWallet}
          ariaLabel="Edit funding wallet"
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
              <h2 className="text-lg font-medium tracking-tight text-text-extra-high">
                Edit funding wallet
              </h2>
              <p className="text-sm text-text-medium">
                Choose the wallet used to fund this recurring payment.
              </p>
            </div>
            <Combobox
              label="Funding wallet"
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
              placeholder="Select a funding wallet"
              searchPlaceholder="Search wallets"
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
                Cancel
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
                Save
              </Button>
            </div>
          </form>
        </Modal>

        <Modal
          isOpen={editingReceivingAccount}
          ariaLabel="Edit receiving wallet"
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
              <h2 className="text-lg font-medium tracking-tight text-text-extra-high">
                Edit receiving wallet
              </h2>
              <p className="text-sm text-text-medium">
                Choose where this recurring payment sends funds.
              </p>
            </div>
            <Combobox
              label="Receiving wallet"
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
              placeholder="Select a receiving wallet"
              searchPlaceholder="Search wallets"
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
                Cancel
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
                Save
              </Button>
            </div>
          </form>
        </Modal>

        <Modal
          isOpen={editingAmount}
          ariaLabel="Edit amount"
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
              <h2 className="text-lg font-medium tracking-tight text-text-extra-high">
                Edit amount
              </h2>
              <p className="text-sm text-text-medium">
                Set the amount collected each billing period.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="recurring-payment-edit-amount">Amount</Label>
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
                <p className="text-sm text-status-error-text">{amountValidationError}</p>
              ) : (
                <p className="text-sm text-text-low">{currencyLabel}</p>
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
                Cancel
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
                Save
              </Button>
            </div>
          </form>
        </Modal>

        <Modal
          isOpen={editingBillingInterval}
          ariaLabel="Edit billing interval"
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
              <h2 className="text-lg font-medium tracking-tight text-text-extra-high">
                Edit billing interval
              </h2>
              <p className="text-sm text-text-medium">
                Choose how often this recurring payment should collect.
              </p>
            </div>
            <Combobox
              label="Billing interval"
              value={selectedSchedulePreset}
              onChange={(value) => {
                setSelectedSchedulePreset(value as SchedulePreset);
                setBillingIntervalValidationError(null);
              }}
              options={SCHEDULE_PRESETS}
              searchable={false}
              icon={<RepeatIcon />}
              disabled={savingBillingInterval}
            />
            {selectedSchedulePreset === "custom" ? (
              <div className="space-y-2">
                <Label htmlFor="recurring-payment-edit-period-hours">Interval in hours</Label>
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
                  <p className="text-sm text-status-error-text">{billingIntervalValidationError}</p>
                ) : null}
              </div>
            ) : billingIntervalValidationError ? (
              <p className="text-sm text-status-error-text">{billingIntervalValidationError}</p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={savingBillingInterval}
                onClick={closeBillingIntervalModal}
              >
                Cancel
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
                Save
              </Button>
            </div>
          </form>
        </Modal>

        <Modal
          isOpen={editingCurrency}
          ariaLabel="Edit currency"
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
              <h2 className="text-lg font-medium tracking-tight text-text-extra-high">
                Edit currency
              </h2>
              <p className="text-sm text-text-medium">
                Choose a token balance from the funding wallet.
              </p>
            </div>
            <Combobox
              label="Currency"
              value={selectedToken}
              onChange={(value) => {
                setSelectedToken(value);
                setCurrencyValidationError(null);
              }}
              options={assetOptions}
              placeholder={
                assetOptions.length === 0 ? "No supported token balances" : "Select a currency"
              }
              searchPlaceholder="Search currencies"
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
                Cancel
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
                Save
              </Button>
            </div>
          </form>
        </Modal>

        <RecurringPaymentCollectionHistory
          attempts={collectionAttempts}
          total={collectionAttemptsTotal}
          error={collectionAttemptsError}
          wallets={wallets}
        />

        <Modal
          isOpen={cancelConfirmOpen}
          ariaLabel="Cancel recurring payment"
          onClose={pendingAction === "cancel" ? undefined : () => setCancelConfirmOpen(false)}
          size="sm"
        >
          <div className="space-y-5 p-6">
            <div className="space-y-1">
              <h2 className="text-lg font-medium tracking-tight text-text-extra-high">
                Cancel recurring payment?
              </h2>
              <p className="text-sm text-text-medium">
                This stops future collections for {counterpartyLabel}. You can resume the payment
                later from the Actions menu.
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
                Keep payment
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
                Cancel payment
              </Button>
            </div>
          </div>
        </Modal>
      </div>
    </div>
  );
}
