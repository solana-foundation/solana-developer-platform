"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect, useState } from "react";
import { type AppLocale, defaultLocale, isAppLocale, localeCookieName } from "@/i18n/config";
import { getMessages, translate } from "@/i18n/messages";

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

  useEffect(() => {
    const id = Sentry.captureException(error);
    setEventId(id);
    setLocale(resolveClientLocale());
  }, [error]);

  const messages = getMessages(locale);

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
