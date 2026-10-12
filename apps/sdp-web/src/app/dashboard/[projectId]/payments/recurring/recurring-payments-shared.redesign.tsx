"use client";

import {
  type CounterpartyAccount,
  PAYMENT_RECURRING_PAYMENT_SCHEDULE_PRESETS,
  type PaymentRecurringPaymentSchedulePreset,
  type PaymentRecurringPaymentStatus,
  type PaymentsDashboardWallet,
  WELL_KNOWN_TOKEN_BY_MINT,
} from "@sdp/types";
import { z } from "zod";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import { shortenAddress } from "../payments-overview.utils";
import { ONCHAIN_AMOUNT_PATTERN } from "../ramps/schema";

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

export type Translate = (key: MessageKey, values?: TranslationValues) => string;

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

export type SchedulePreset = PaymentRecurringPaymentSchedulePreset;

export function getSchedulePresets(t: Translate) {
  const labels = {
    "24": t("DashboardPayments.recurring.everyDay"),
    "168": t("DashboardPayments.recurring.everyWeek"),
    "720": t("DashboardPayments.recurring.everyThirtyDays"),
    custom: t("DashboardPayments.recurring.custom"),
  } satisfies Record<SchedulePreset, string>;
  const descriptions = {
    "24": t("DashboardPayments.recurring.collectDaily"),
    "168": t("DashboardPayments.recurring.collectWeekly"),
    "720": t("DashboardPayments.recurring.collectMonthly"),
    custom: t("DashboardPayments.recurring.customScheduleDescription"),
  } satisfies Record<SchedulePreset, string>;
  return PAYMENT_RECURRING_PAYMENT_SCHEDULE_PRESETS.map((value) => ({
    value,
    label: labels[value],
    description: descriptions[value],
  }));
}

export function schedulePresetForPeriodHours(periodHours: number): SchedulePreset {
  const parsed = z.enum(PAYMENT_RECURRING_PAYMENT_SCHEDULE_PRESETS).safeParse(String(periodHours));
  return parsed.success && parsed.data !== "custom" ? parsed.data : "custom";
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

export function walletLabel(
  wallet: RecurringPaymentWalletView | null,
  fallbackWalletId: string
): string {
  if (!wallet) {
    return fallbackWalletId;
  }
  return wallet.label === null ? shortenAddress(wallet.publicKey) : wallet.label;
}

export function accountAddress(account: CounterpartyAccount | null): string {
  return account === null ? "" : account.details.address;
}

export function accountLabel(
  account: CounterpartyAccount | null,
  fallbackAccountId: string
): string {
  if (!account) {
    return fallbackAccountId;
  }
  return account.label === null ? shortenAddress(accountAddress(account)) : account.label;
}

export function isDueNow(value: string | null): boolean {
  return Boolean(value && Date.parse(value) <= Date.now());
}
