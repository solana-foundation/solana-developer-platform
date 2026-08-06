"use client";

import {
  type CounterpartyAccount,
  type PaymentRecurringPaymentStatus,
  type PaymentsDashboardWallet,
  WELL_KNOWN_TOKEN_BY_MINT,
} from "@sdp/types";
import { CopyIcon, ExternalLinkIcon } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { explorerAddressUrl, explorerTxUrl } from "@/lib/explorer";
import { useSolanaCluster } from "@/lib/use-solana-cluster";
import { formatTimestamp, shortenAddress } from "../payments-overview.utils";
import { ONCHAIN_AMOUNT_PATTERN } from "../ramps/schema";

export const STATUS_VARIANTS = {
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

export const STATUS_TRANSLATION_KEYS = {
  pending_activation: "DashboardPayments.recurring.pendingActivation",
  activating: "DashboardPayments.recurring.activating",
  active: "DashboardPayments.recurring.active",
  updating: "DashboardPayments.recurring.updating",
  canceling: "DashboardPayments.recurring.canceling",
  resuming: "DashboardPayments.recurring.resuming",
  paused: "DashboardPayments.recurring.paused",
  canceled: "DashboardPayments.recurring.canceled",
  expired: "DashboardPayments.recurring.expired",
} as const satisfies Record<PaymentRecurringPaymentStatus, MessageKey>;

export type RecurringPaymentWalletView = PaymentsDashboardWallet;

export interface RecurringPaymentCounterpartyView {
  id: string;
  displayName: string;
}

export function RecurringPaymentStatusBadge({ status }: { status: PaymentRecurringPaymentStatus }) {
  const t = useTranslations();
  return <Badge variant={STATUS_VARIANTS[status]}>{t(STATUS_TRANSLATION_KEYS[status])}</Badge>;
}

export type Translate = (key: MessageKey, values?: TranslationValues) => string;

export function formatOptionalTimestamp(value: string | null | undefined, t: Translate): string {
  return value ? formatTimestamp(value, t) : t("DashboardPayments.recurring.notSet");
}

export function formatPeriodHours(periodHours: number, t: Translate): string {
  if (periodHours === 24) {
    return t("DashboardPayments.recurring.everyDay");
  }
  if (periodHours % 168 === 0) {
    const weeks = periodHours / 168;
    return weeks === 1
      ? t("DashboardPayments.recurring.everyWeek")
      : t("DashboardPayments.recurring.everyWeeks", { count: weeks });
  }
  if (periodHours % 24 === 0) {
    const days = periodHours / 24;
    return days === 1
      ? t("DashboardPayments.recurring.everyDay")
      : t("DashboardPayments.recurring.everyDays", { count: days });
  }
  return periodHours === 1
    ? t("DashboardPayments.recurring.everyHour")
    : t("DashboardPayments.recurring.everyHours", { count: periodHours });
}

export type SchedulePreset = "24" | "168" | "720" | "custom";

export function getSchedulePresets(t: Translate) {
  return [
    {
      value: "24",
      label: t("DashboardPayments.recurring.everyDay"),
      description: t("DashboardPayments.recurring.collectDaily"),
    },
    {
      value: "168",
      label: t("DashboardPayments.recurring.everyWeek"),
      description: t("DashboardPayments.recurring.collectWeekly"),
    },
    {
      value: "720",
      label: t("DashboardPayments.recurring.everyThirtyDays"),
      description: t("DashboardPayments.recurring.collectMonthly"),
    },
    {
      value: "custom",
      label: t("DashboardPayments.recurring.custom"),
      description: t("DashboardPayments.recurring.customScheduleDescription"),
    },
  ] as const satisfies readonly { value: SchedulePreset; label: string; description: string }[];
}

export function schedulePresetForPeriodHours(periodHours: number): SchedulePreset {
  return ["24", "168", "720"].some((preset) => preset === String(periodHours))
    ? (String(periodHours) as SchedulePreset)
    : "custom";
}

export function parsePeriodHours(
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

export function amountIsValid(value: string): boolean {
  return ONCHAIN_AMOUNT_PATTERN.test(value.trim()) && Number(value) > 0;
}

export function resolveTokenLabel(token: string, wallets: RecurringPaymentWalletView[]): string {
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

export function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-4 py-3">
      <span className="shrink-0 text-sm text-secondary">{label}</span>
      <span className="min-w-0 break-all text-right text-sm font-medium text-primary">
        {children}
      </span>
    </div>
  );
}

export function CopyableValue({
  value,
  label,
  empty,
}: {
  value: string | null;
  label?: string;
  empty?: string;
}) {
  const t = useTranslations();
  if (!value) {
    return (
      <span className="text-tertiary">{empty ?? t("DashboardPayments.recurring.notSet")}</span>
    );
  }

  return (
    <span className="inline-flex max-w-full items-center justify-end gap-2">
      <span className="min-w-0 truncate font-mono text-xs text-primary" title={label ?? value}>
        {label ?? value}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={t("DashboardPayments.recurring.copyValue")}
        onClick={() => {
          void navigator.clipboard.writeText(value);
          toast.success(t("DashboardPayments.recurring.copied"));
        }}
      >
        <CopyIcon />
      </Button>
    </span>
  );
}

export function ExplorerValue({
  value,
  kind = "tx",
}: {
  value: string | null;
  kind?: "tx" | "address";
}) {
  const t = useTranslations();
  const cluster = useSolanaCluster();
  if (!value) {
    return <span className="text-tertiary">{t("DashboardPayments.recurring.notSet")}</span>;
  }

  return (
    <span className="inline-flex max-w-full items-center gap-1.5">
      <CopyableValue value={value} label={shortenAddress(value)} />
      <Button
        asChild
        variant="ghost"
        size="icon-xs"
        aria-label={
          kind === "address"
            ? t("DashboardPayments.recurring.openAccount")
            : t("DashboardPayments.recurring.openSignature")
        }
      >
        <a
          href={
            kind === "address" ? explorerAddressUrl(value, cluster) : explorerTxUrl(value, cluster)
          }
          target="_blank"
          rel="noreferrer"
        >
          <ExternalLinkIcon />
        </a>
      </Button>
    </span>
  );
}

export function walletLabel(
  wallet: RecurringPaymentWalletView | null,
  fallbackWalletId: string
): string {
  if (!wallet) {
    return fallbackWalletId;
  }
  return wallet.label || shortenAddress(wallet.publicKey);
}

export function accountAddress(account: CounterpartyAccount | null): string {
  const address = account?.details.address;
  return typeof address === "string" ? address : "";
}

export function accountLabel(
  account: CounterpartyAccount | null,
  fallbackAccountId: string
): string {
  if (!account) {
    return fallbackAccountId;
  }
  return account.label || shortenAddress(accountAddress(account));
}

export function isDueNow(value: string | null): boolean {
  return Boolean(value && Date.parse(value) <= Date.now());
}
