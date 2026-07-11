"use client";

import * as Sentry from "@sentry/nextjs";
import NextError from "next/error";
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
        {/* `NextError` is the default Next.js error page component. Its type
        definition requires a `statusCode` prop. However, since the App Router
        does not expose status codes for errors, we simply pass 0 to render a
        generic error message. */}
        <NextError statusCode={0} />
        <button onClick={() => reset()} type="button">
          {translate(messages, "Error.tryAgain")}
        </button>
        {eventId ? (
          <button onClick={() => Sentry.showReportDialog({ eventId })} type="button">
            {translate(messages, "Error.reportIssue")}
          </button>
        ) : null}
      </body>
    </html>
  );
}
