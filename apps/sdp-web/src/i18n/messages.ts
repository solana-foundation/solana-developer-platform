import type { AppLocale } from "@/i18n/config";
import dashboardApprovals from "../../messages/en/dashboard-approvals.json";
import dashboardCustody from "../../messages/en/dashboard-custody.json";
import dashboardIssuance from "../../messages/en/dashboard-issuance.json";
import dashboardPayments from "../../messages/en/dashboard-payments.json";
import dashboardPolicies from "../../messages/en/dashboard-policies.json";
import shared from "../../messages/en/shared.json";
import en from "../../messages/en.json";
import frDashboardApprovals from "../../messages/fr/dashboard-approvals.json";
import frDashboardCustody from "../../messages/fr/dashboard-custody.json";
import frDashboardIssuance from "../../messages/fr/dashboard-issuance.json";
import frDashboardPayments from "../../messages/fr/dashboard-payments.json";
import frDashboardPolicies from "../../messages/fr/dashboard-policies.json";
import frShared from "../../messages/fr/shared.json";
import fr from "../../messages/fr.json";

const enMessages = {
  ...en,
  ...dashboardApprovals,
  ...dashboardCustody,
  ...dashboardIssuance,
  ...dashboardPayments,
  ...dashboardPolicies,
  Shared: shared,
};

export type Messages = typeof enMessages;

const frMessages = {
  ...fr,
  ...frDashboardApprovals,
  ...frDashboardCustody,
  ...frDashboardIssuance,
  ...frDashboardPayments,
  ...frDashboardPolicies,
  Shared: frShared,
} satisfies Messages;

export type MessageKeyFor<TValue> = TValue extends string
  ? ""
  : {
      [TKey in Extract<keyof TValue, string>]: TValue[TKey] extends string
        ? TKey
        : `${TKey}.${MessageKeyFor<TValue[TKey]>}`;
    }[Extract<keyof TValue, string>];

export type MessageKey = MessageKeyFor<Messages>;
export type TranslationValues = Record<string, string | number>;

const messagesByLocale: Record<AppLocale, Messages> = {
  en: enMessages,
  fr: frMessages,
};

export function getMessages(locale: AppLocale): Messages {
  return messagesByLocale[locale];
}

export function translate<TMessages>(
  messages: TMessages,
  key: MessageKeyFor<TMessages> & string,
  values?: TranslationValues
): string {
  const message = key.split(".").reduce<unknown>((value, segment) => {
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)[segment]
      : undefined;
  }, messages);

  if (typeof message !== "string") {
    throw new Error(`Missing translation for ${key}`);
  }

  return message.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = values?.[name];
    if (value === undefined) {
      throw new Error(`Missing interpolation value ${name} for ${key}`);
    }
    return String(value);
  });
}
