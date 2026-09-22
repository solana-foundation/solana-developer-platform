import type { AppLocale } from "@/i18n/config";
import { englishSourceMessages } from "./locales/en";
import {
  type MessageKeyFor,
  mergeLocalizedMessages,
  mergeLocalizedMessagesWithEmbeddedYieldBrand,
  type TranslationValues,
  translate,
} from "./translate";

export type { MessageKeyFor, TranslationValues };
export {
  englishSourceMessages,
  mergeLocalizedMessages,
  mergeLocalizedMessagesWithEmbeddedYieldBrand,
  translate,
};

export type Messages = typeof englishSourceMessages;

export type MessageKey = MessageKeyFor<Messages>;

/**
 * The English source catalog, available synchronously everywhere: it is the
 * merge fallback, the OpenGraph image reads it at module scope, and the global
 * error boundary paints with it before a localized catalog can load.
 *
 * Localized catalogs are only reachable through `loadMessages`, which loads
 * them as separate async chunks. Keeping them out of the synchronous module
 * graph keeps roughly 1.5 MB of localized JSON out of the client bundle that
 * every page ships.
 */
export function getMessages(locale: AppLocale): Messages {
  if (locale === "en") return englishSourceMessages;
  throw new Error(
    `Only the English catalog is synchronous. Await loadMessages("${locale}") for localized catalogs.`
  );
}

const localizedMessages = new Map<Exclude<AppLocale, "en">, Promise<Messages>>();

/**
 * The merged catalog for a locale: the English source with every localized
 * value that release automation has filled in so far. English resolves
 * without loading anything; each other locale is loaded once per runtime and
 * cached (the promise, so concurrent first callers share one merge).
 */
export async function loadMessages(locale: AppLocale): Promise<Messages> {
  if (locale === "en") return englishSourceMessages;

  const cached = localizedMessages.get(locale);
  if (cached) return cached;

  const pending = (async (): Promise<Messages> => {
    switch (locale) {
      case "es": {
        const { catalog } = await import("./locales/es");
        return mergeLocalizedMessagesWithEmbeddedYieldBrand(englishSourceMessages, catalog);
      }
      case "fr": {
        const { catalog } = await import("./locales/fr");
        return mergeLocalizedMessagesWithEmbeddedYieldBrand(englishSourceMessages, catalog);
      }
      case "pt": {
        const { catalog } = await import("./locales/pt");
        return mergeLocalizedMessagesWithEmbeddedYieldBrand(englishSourceMessages, catalog);
      }
      case "vi": {
        const { catalog } = await import("./locales/vi");
        return mergeLocalizedMessagesWithEmbeddedYieldBrand(englishSourceMessages, catalog);
      }
    }
  })();
  localizedMessages.set(locale, pending);
  return pending;
}
