import type { MessageKey, TranslationValues } from "@/i18n/messages";
import type { WizardSummaryDetail } from "../wizard-summary-list";
import { isEmptyMemoRow, type MemoRow } from "./memo";

type Translate = (key: MessageKey, values?: TranslationValues) => string;

/**
 * Wraps a selection into a labeled summary detail once it has a value.
 *
 * @param value - The chosen value; null while the user has not made the selection.
 * @param label - The detail label naming the selection.
 * @returns A single detail, or none while the value is missing.
 */
export function optionalDetail(value: string | null, label: string): WizardSummaryDetail[] {
  return value === null ? [] : [{ label, value }];
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
      t("DashboardPayments.counterpartyLabel")
    ),
    ...optionalDetail(methodLabel, t("DashboardPayments.method")),
  ];
}

/**
 * Builds the memo field-count summary detail from the wizard memo rows.
 *
 * @param t - Translator resolved from the i18n provider.
 * @param memoRows - Current memo rows from the ramp wizard.
 * @returns A single field-count detail, or none while the memo is empty.
 */
export function memoSummaryDetails(t: Translate, memoRows: MemoRow[]): WizardSummaryDetail[] {
  const count = memoRows.filter((row) => !isEmptyMemoRow(row)).length;
  if (count === 0) {
    return [];
  }
  return [
    {
      label: t("DashboardPayments.ramps.rampMemoStep"),
      value:
        count === 1
          ? t("DashboardPayments.ramps.memoSummaryCountOne")
          : t("DashboardPayments.ramps.memoSummaryCountOther", { count }),
    },
  ];
}
