"use client";

import { createContext, type ReactNode, useContext, useEffect, useSyncExternalStore } from "react";
import { defaultTimeZone, timeZoneCookieName } from "@/i18n/config";

const timeZoneCookieMaxAgeSeconds = 60 * 60 * 24 * 365;

/** The zone the server rendered the page's dates in (`getRequestTimeZone`). */
const ServedTimeZoneContext = createContext(defaultTimeZone);

/** The browser's zone is read once per render; nothing announces a change to subscribe to. */
function subscribeToNothing(): () => void {
  return () => {};
}

function readBrowserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Serves the zone the server rendered in to the dates below, and stores the browser's zone in
 * the cookie the server reads when the two differ, so the next page arrives in the viewer's time.
 *
 * @param props.timeZone - The zone `getRequestTimeZone` resolved for this request.
 */
export function TimeZoneProvider({
  timeZone,
  children,
}: {
  timeZone: string;
  children: ReactNode;
}) {
  useEffect(() => {
    const browserTimeZone = readBrowserTimeZone();
    if (browserTimeZone === timeZone) return;
    // biome-ignore lint/suspicious/noDocumentCookie: The server renders dates in this zone from the next request on.
    document.cookie = `${timeZoneCookieName}=${encodeURIComponent(browserTimeZone)}; Path=/; Max-Age=${timeZoneCookieMaxAgeSeconds}; SameSite=Lax; Secure`;
  }, [timeZone]);
  return (
    <ServedTimeZoneContext.Provider value={timeZone}>{children}</ServedTimeZoneContext.Provider>
  );
}

/**
 * The zone to format a viewer's dates in. The server render and hydration both use the zone the
 * server served, so their text agrees; the browser's own zone replaces it right after hydration
 * when they differ, and a page the browser renders itself starts in it.
 *
 * @returns An IANA zone name to pass as `Intl.DateTimeFormat`'s `timeZone`.
 */
export function useTimeZone(): string {
  const servedTimeZone = useContext(ServedTimeZoneContext);
  return useSyncExternalStore(subscribeToNothing, readBrowserTimeZone, () => servedTimeZone);
}
