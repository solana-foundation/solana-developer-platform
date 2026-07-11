import type { AppLocale } from "@/i18n/config";
import dashboardCustody from "../../messages/en/dashboard-custody.json";
import dashboardIssuance from "../../messages/en/dashboard-issuance.json";
import dashboardPayments from "../../messages/en/dashboard-payments.json";
import shared from "../../messages/en/shared.json";
import en from "../../messages/en.json";

const enMessages = {
  ...en,
  ...dashboardCustody,
  ...dashboardIssuance,
  ...dashboardPayments,
  Shared: shared,
};

export type Messages = typeof enMessages;

type LeafMessageKeys<TValue> = TValue extends string
  ? ""
  : {
      [TKey in Extract<keyof TValue, string>]: TValue[TKey] extends string
        ? TKey
        : `${TKey}.${LeafMessageKeys<TValue[TKey]>}`;
    }[Extract<keyof TValue, string>];

export type MessageKey = LeafMessageKeys<Messages>;
export type TranslationValues = Record<string, string | number>;

const messagesByLocale: Record<AppLocale, Messages> = { en: enMessages };

export function getMessages(locale: AppLocale): Messages {
  return messagesByLocale[locale];
}

export function translate(messages: unknown, key: MessageKey, values?: TranslationValues): string {
  const message = key.split(".").reduce<unknown>((value, segment) => {
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)[segment]
      : undefined;
  }, messages);

  if (typeof message !== "string") {
    throw new Error(`Missing translation for ${key}`);
  }

  return message.replace(/\{(\w+)\}/g, (_, name: string) => String(values?.[name] ?? `{${name}}`));
}
