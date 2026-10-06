"use client";

import { createContext, type ReactNode, useContext, useMemo } from "react";

/**
 * The catalog keys the primitives read for their built-in labels. They are the host app's own
 * keys (sdp-web's `Shared.SharedComponents.*`), so the package carries no copy: the app passes
 * its translator in through {@link UiI18nProvider} and the rendered strings stay its catalog's.
 */
export type UiMessageKey =
  | "Shared.SharedComponents.chooseDate"
  | "Shared.SharedComponents.chooseDateAndTime"
  | "Shared.SharedComponents.chooseDateRange"
  | "Shared.SharedComponents.chooseEndDate"
  | "Shared.SharedComponents.clear"
  | "Shared.SharedComponents.closeModal"
  | "Shared.SharedComponents.done"
  | "Shared.SharedComponents.loading"
  | "Shared.SharedComponents.nextPage"
  | "Shared.SharedComponents.noOptionsAvailable"
  | "Shared.SharedComponents.noSearchMatches"
  | "Shared.SharedComponents.openCalendarFor"
  | "Shared.SharedComponents.pageOf"
  | "Shared.SharedComponents.previousPage"
  | "Shared.SharedComponents.required"
  | "Shared.SharedComponents.rowsCount"
  | "Shared.SharedComponents.rowsPerPage"
  | "Shared.SharedComponents.search"
  | "Shared.SharedComponents.selectAnOption"
  | "Shared.SharedComponents.time";

export type UiTranslationValues = Record<string, string | number>;

export type UiTranslate = (key: UiMessageKey, values?: UiTranslationValues) => string;

type UiI18nContextValue = {
  locale: string;
  translate: UiTranslate;
};

const UiI18nContext = createContext<UiI18nContextValue | null>(null);

// Without a provider a label renders as its key and dates format in English: what a bare render
// (a story, a test that stubs the app's i18n) shows instead of throwing.
const FALLBACK: UiI18nContextValue = { locale: "en", translate: (key) => key };

/**
 * Supplies the locale and translator the primitives read their built-in labels from. sdp-web
 * renders it inside its own I18nProvider, so every tree that has the app's translations has
 * these too.
 */
export function UiI18nProvider({
  children,
  locale,
  translate,
}: UiI18nContextValue & { children: ReactNode }) {
  const value = useMemo(() => ({ locale, translate }), [locale, translate]);
  return <UiI18nContext.Provider value={value}>{children}</UiI18nContext.Provider>;
}

export function useUiLocale(): string {
  return (useContext(UiI18nContext) ?? FALLBACK).locale;
}

export function useUiTranslations(): UiTranslate {
  return (useContext(UiI18nContext) ?? FALLBACK).translate;
}
