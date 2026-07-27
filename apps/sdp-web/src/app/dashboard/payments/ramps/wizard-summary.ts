import type { RampProviderId } from "@sdp/types";
import { CreditCardIcon, FileTextIcon, type LucideIcon, UserRoundIcon } from "lucide-react";
import { formatTokenAmount } from "@/app/dashboard/payments/payments-overview.utils";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import { getRampProviderLabel, RAMP_PROVIDER_LOGOS } from "@/lib/ramps";
import type { WizardSummaryDetail } from "../wizard-summary-list";
import { isEmptyMemoRow, type MemoRow, memoRowsToRecord } from "./memo";

type Translate = (key: MessageKey, values?: TranslationValues) => string;

const COMPLETE_AMOUNT_PATTERN = /^\d+(?:\.\d+)?$/;

/**
 * Formats a wizard amount for summary display, preserving partial input
 * (e.g. a trailing decimal point) while the user is still typing.
 *
 * @param amount - Raw amount input from the wizard fields.
 * @param locale - Active locale used for digit grouping.
 * @returns The display amount, or null while the field is empty.
 */
export function summaryAmount(amount: string, locale: string): string | null {
  if (amount.length === 0) {
    return null;
  }
  return COMPLETE_AMOUNT_PATTERN.test(amount) ? formatTokenAmount(amount, locale) : amount;
}

/**
 * Wraps a selection into a labeled summary detail once it has a value.
 *
 * @param value - The chosen value; null while the user has not made the selection.
 * @param label - The detail label naming the selection.
 * @param icon - The icon rendered ahead of the label.
 * @returns A single detail, or none while the value is missing.
 */
export function optionalDetail(
  value: string | null,
  label: string,
  icon: LucideIcon
): WizardSummaryDetail[] {
  return value === null ? [] : [{ icon, label, value }];
}

/**
 * Builds summary details for the counterparty and method selections made
 * before every payments action rail.
 *
 * @param t - Translator resolved from the i18n provider.
 * @param counterpartyName - Selected counterparty display name; empty until chosen.
 * @param methodLabel - Chosen payment method label; null until chosen.
 * @returns The labeled pre-step selections made so far.
 */
export function preStepSummaryDetails(
  t: Translate,
  counterpartyName: string,
  methodLabel: string | null
): WizardSummaryDetail[] {
  return [
    ...optionalDetail(
      counterpartyName.length === 0 ? null : counterpartyName,
      t("DashboardPayments.counterpartyLabel"),
      UserRoundIcon
    ),
    ...optionalDetail(methodLabel, t("DashboardPayments.method"), CreditCardIcon),
  ];
}

/**
 * Builds the chosen ramp provider's summary detail with its logo.
 *
 * @param t - Translator resolved from the i18n provider.
 * @param provider - The chosen ramp provider; null until chosen.
 * @returns A single provider detail, or none while unchosen.
 */
export function providerSummaryDetail(
  t: Translate,
  provider: RampProviderId | null
): WizardSummaryDetail[] {
  if (provider === null) {
    return [];
  }
  return [
    {
      icon: RAMP_PROVIDER_LOGOS[provider],
      label: t("DashboardPayments.ramps.provider"),
      value: getRampProviderLabel(provider),
    },
  ];
}

/**
 * Builds the memo summary detail from the wizard memo rows, carrying the
 * memo payload for the summary's JSON drill-in.
 *
 * @param t - Translator resolved from the i18n provider.
 * @param memoRows - Current memo rows from the ramp wizard.
 * @returns A single memo detail, or none while the memo is empty.
 */
export function memoSummaryDetails(t: Translate, memoRows: MemoRow[]): WizardSummaryDetail[] {
  if (!memoRows.some((row) => !isEmptyMemoRow(row))) {
    return [];
  }
  return [
    {
      icon: FileTextIcon,
      label: t("DashboardPayments.ramps.rampMemoStep"),
      json: memoRowsToRecord(memoRows),
    },
  ];
}
