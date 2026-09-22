"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect, useState } from "react";
import { type AppLocale, defaultLocale, isAppLocale, localeCookieName } from "@/i18n/config";
import { englishSourceMessages, loadMessages, type Messages, translate } from "@/i18n/messages";

function resolveClientLocale(): AppLocale {
  const cookieLocale = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${localeCookieName}=`))
    ?.slice(localeCookieName.length + 1);
  if (isAppLocale(cookieLocale)) return cookieLocale;

  const documentLocale = document.documentElement.lang;
  if (isAppLocale(documentLocale)) return documentLocale;

  if (isAppLocale(navigator.language)) return navigator.language;

  const browserBaseLocale = navigator.language.split("-", 1)[0];
  return isAppLocale(browserBaseLocale) ? browserBaseLocale : defaultLocale;
}

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [eventId, setEventId] = useState<string | null>(null);
  const [locale, setLocale] = useState<AppLocale>(defaultLocale);
  // English paints first, exactly as before (locale state starts at the
  // default). Localized catalogs live in their own async chunks rather than
  // the main bundle, so the resolved locale's catalog swaps in once loaded —
  // and `locale` (the rendered lang) flips only together with it, so the
  // document never claims a language the rendered copy doesn't speak, even
  // while loading or if the catalog fails to load.
  const [messages, setMessages] = useState<Messages>(englishSourceMessages);

  useEffect(() => {
    const id = Sentry.captureException(error);
    setEventId(id);
    const resolvedLocale = resolveClientLocale();
    let cancelled = false;
    loadMessages(resolvedLocale)
      .then((localized) => {
        if (!cancelled) {
          setLocale(resolvedLocale);
          setMessages(localized);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [error]);

  return (
    <html lang={locale}>
      <body>
        <main>
          <h1>{translate(messages, "Error.viewTitle")}</h1>
          <p>{translate(messages, "Error.viewDescription")}</p>
          <button onClick={() => reset()} type="button">
            {translate(messages, "Error.tryAgain")}
          </button>
          {eventId ? (
            <button onClick={() => Sentry.showReportDialog({ eventId })} type="button">
              {translate(messages, "Error.reportIssue")}
            </button>
          ) : null}
        </main>
      </body>
    </html>
  );
}
