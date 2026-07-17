import type { AppLocale } from "@/i18n/config";
import enDashboardCustody from "../../messages/en/dashboard-custody.json";
import enDashboardIssuance from "../../messages/en/dashboard-issuance.json";
import enDashboardPayments from "../../messages/en/dashboard-payments.json";
import enShared from "../../messages/en/shared.json";
import en from "../../messages/en.json";
import kkDashboardCustody from "../../messages/kk/dashboard-custody.json";
import kkDashboardIssuance from "../../messages/kk/dashboard-issuance.json";
import kkDashboardPayments from "../../messages/kk/dashboard-payments.json";
import kkShared from "../../messages/kk/shared.json";
import kk from "../../messages/kk.json";
import ruDashboardCustody from "../../messages/ru/dashboard-custody.json";
import ruDashboardIssuance from "../../messages/ru/dashboard-issuance.json";
import ruDashboardPayments from "../../messages/ru/dashboard-payments.json";
import ruShared from "../../messages/ru/shared.json";
import ru from "../../messages/ru.json";

const enMessages = {
  ...en,
  ...enDashboardCustody,
  ...enDashboardIssuance,
  ...enDashboardPayments,
  Shared: enShared,
};

export type Messages = typeof enMessages;

const kkMessages = {
  ...kk,
  ...kkDashboardCustody,
  ...kkDashboardIssuance,
  ...kkDashboardPayments,
  Shared: kkShared,
} as Messages;

const ruMessages = {
  ...ru,
  ...ruDashboardCustody,
  ...ruDashboardIssuance,
  ...ruDashboardPayments,
  Shared: ruShared,
} as Messages;

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
  kk: kkMessages,
  ru: ruMessages,
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
