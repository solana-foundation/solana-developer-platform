"use client";

import { createContext, type ReactNode, useContext, useMemo } from "react";
import type { AppLocale } from "@/i18n/config";
import { type MessageKey, type Messages, type TranslationValues, translate } from "@/i18n/messages";

type I18nContextValue = {
  locale: AppLocale;
  messages: Messages;
};

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({
  children,
  locale,
  messages,
}: I18nContextValue & { children: ReactNode }) {
  return <I18nContext.Provider value={{ locale, messages }}>{children}</I18nContext.Provider>;
}

export function useLocale(): AppLocale {
  const context = useContext(I18nContext);
  if (!context) throw new Error("useLocale must be used within I18nProvider");
  return context.locale;
}

export function useTranslations() {
  const context = useContext(I18nContext);
  if (!context) throw new Error("useTranslations must be used within I18nProvider");

  return useMemo(
    () => (key: MessageKey, values?: TranslationValues) => translate(context.messages, key, values),
    [context.messages]
  );
}
