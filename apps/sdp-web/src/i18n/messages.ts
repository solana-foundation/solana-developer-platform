import type { AppLocale } from "@/i18n/config";
import dashboardApprovals from "../../messages/en/dashboard-approvals.json";
import dashboardCustody from "../../messages/en/dashboard-custody.json";
import dashboardEarn from "../../messages/en/dashboard-earn.json";
import dashboardIssuance from "../../messages/en/dashboard-issuance.json";
import dashboardPayments from "../../messages/en/dashboard-payments.json";
import dashboardPolicies from "../../messages/en/dashboard-policies.json";
import dashboardPrivateChannels from "../../messages/en/dashboard-private-channels.json";
import shared from "../../messages/en/shared.json";
import en from "../../messages/en.json";
import esDashboardApprovals from "../../messages/es/dashboard-approvals.json";
import esDashboardCustody from "../../messages/es/dashboard-custody.json";
import esDashboardIssuance from "../../messages/es/dashboard-issuance.json";
import esDashboardPayments from "../../messages/es/dashboard-payments.json";
import esDashboardPolicies from "../../messages/es/dashboard-policies.json";
import esDashboardPrivateChannels from "../../messages/es/dashboard-private-channels.json";
import esShared from "../../messages/es/shared.json";
import es from "../../messages/es.json";
import frDashboardApprovals from "../../messages/fr/dashboard-approvals.json";
import frDashboardCustody from "../../messages/fr/dashboard-custody.json";
// No fr/dashboard-earn.json: product branches ship English source only; the
// translation bot adds localized Earn copy on the release PR. Earn keys fall
// back to English via mergeLocalizedMessages until then.
import frDashboardIssuance from "../../messages/fr/dashboard-issuance.json";
import frDashboardPayments from "../../messages/fr/dashboard-payments.json";
import frDashboardPolicies from "../../messages/fr/dashboard-policies.json";
import frShared from "../../messages/fr/shared.json";
import fr from "../../messages/fr.json";
import ptDashboardApprovals from "../../messages/pt/dashboard-approvals.json";
import ptDashboardCustody from "../../messages/pt/dashboard-custody.json";
import ptDashboardIssuance from "../../messages/pt/dashboard-issuance.json";
import ptDashboardPayments from "../../messages/pt/dashboard-payments.json";
import ptDashboardPolicies from "../../messages/pt/dashboard-policies.json";
import ptDashboardPrivateChannels from "../../messages/pt/dashboard-private-channels.json";
import ptShared from "../../messages/pt/shared.json";
import pt from "../../messages/pt.json";
import viDashboardApprovals from "../../messages/vi/dashboard-approvals.json";
import viDashboardCustody from "../../messages/vi/dashboard-custody.json";
import viDashboardEarn from "../../messages/vi/dashboard-earn.json";
import viDashboardIssuance from "../../messages/vi/dashboard-issuance.json";
import viDashboardPayments from "../../messages/vi/dashboard-payments.json";
import viDashboardPolicies from "../../messages/vi/dashboard-policies.json";
import viDashboardPrivateChannels from "../../messages/vi/dashboard-private-channels.json";
import viShared from "../../messages/vi/shared.json";
import vi from "../../messages/vi.json";

const enMessages = {
  ...en,
  ...dashboardApprovals,
  ...dashboardCustody,
  ...dashboardEarn,
  ...dashboardIssuance,
  ...dashboardPayments,
  ...dashboardPolicies,
  ...dashboardPrivateChannels,
  Shared: shared,
};

export type Messages = typeof enMessages;

type LocalizedMessages<TValue> = {
  [TKey in keyof TValue]?: TValue[TKey] extends string ? string : LocalizedMessages<TValue[TKey]>;
};

export function mergeLocalizedMessages<TValue>(
  fallback: TValue,
  localized: LocalizedMessages<TValue> | undefined
): TValue {
  return mergeLocalizedValue(fallback, localized) as TValue;
}

function mergeLocalizedValue(fallback: unknown, localized: unknown): unknown {
  if (typeof fallback === "string") {
    return typeof localized === "string" ? localized : fallback;
  }
  if (!fallback || typeof fallback !== "object" || Array.isArray(fallback)) {
    return fallback;
  }

  const localizedRecord =
    localized && typeof localized === "object" && !Array.isArray(localized)
      ? (localized as Record<string, unknown>)
      : {};
  return Object.fromEntries(
    Object.entries(fallback).map(([key, fallbackValue]) => [
      key,
      mergeLocalizedValue(fallbackValue, localizedRecord[key]),
    ])
  );
}

const esCatalog = {
  ...es,
  ...esDashboardApprovals,
  ...esDashboardCustody,
  ...esDashboardIssuance,
  ...esDashboardPayments,
  ...esDashboardPolicies,
  ...esDashboardPrivateChannels,
  Shared: esShared,
} satisfies LocalizedMessages<Messages>;

const esMessages = mergeLocalizedMessages(enMessages, esCatalog);

const frCatalog = {
  ...fr,
  ...frDashboardApprovals,
  ...frDashboardCustody,
  ...frDashboardIssuance,
  ...frDashboardPayments,
  ...frDashboardPolicies,
  Shared: frShared,
} satisfies LocalizedMessages<Messages>;

const frMessages = mergeLocalizedMessages(enMessages, frCatalog);

const ptCatalog = {
  ...pt,
  ...ptDashboardApprovals,
  ...ptDashboardCustody,
  ...ptDashboardIssuance,
  ...ptDashboardPayments,
  ...ptDashboardPolicies,
  ...ptDashboardPrivateChannels,
  Shared: ptShared,
} satisfies LocalizedMessages<Messages>;

const ptMessages = mergeLocalizedMessages(enMessages, ptCatalog);

const viCatalog = {
  ...vi,
  ...viDashboardApprovals,
  ...viDashboardCustody,
  ...viDashboardEarn,
  ...viDashboardIssuance,
  ...viDashboardPayments,
  ...viDashboardPolicies,
  ...viDashboardPrivateChannels,
  Shared: viShared,
} satisfies LocalizedMessages<Messages>;

const viMessages = mergeLocalizedMessages(enMessages, viCatalog);

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
  es: esMessages,
  fr: frMessages,
  pt: ptMessages,
  vi: viMessages,
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
