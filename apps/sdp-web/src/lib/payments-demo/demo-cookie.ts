/**
 * Holds the id of the project whose Payments screens run in demo mode. Naming the project means
 * switching to another one (a production project included) turns the demo off by itself.
 */
export const PAYMENTS_DEMO_COOKIE_NAME = "sdp-payments-demo";

/**
 * What the visitor has done in demo mode since the page was loaded: the log of demo actions,
 * split over numbered cookies (`sdp-demo-session.0`, `.1`, …). It lives in the browser only;
 * the server replays it over the demo fixtures on each read and keeps nothing. A full page load
 * starts it over (the proxy drops it), so a refresh or turning the demo off forgets it.
 */
export const DEMO_SESSION_COOKIE_PREFIX = "sdp-demo-session";

/**
 * Sent by a browser call from a tab that shows demo mode. The cookie is shared by every tab of
 * the browser, so a tab that was left on the demo after another turned it off would otherwise
 * send its next write to the real API; the server refuses that write instead.
 */
export const TAB_DEMO_HEADER_NAME = "x-sdp-tab-demo";

export const PAYMENTS_PATH_PREFIX = "/dashboard/payments";

/** Whether a dashboard path is a Payments screen. */
export function isPaymentsPath(pathname: string | null | undefined): boolean {
  return (
    pathname === PAYMENTS_PATH_PREFIX || Boolean(pathname?.startsWith(`${PAYMENTS_PATH_PREFIX}/`))
  );
}

/** Whether a cookie is one of the demo session's chunks. */
export function isDemoSessionCookie(name: string): boolean {
  return name === DEMO_SESSION_COOKIE_PREFIX || name.startsWith(`${DEMO_SESSION_COOKIE_PREFIX}.`);
}

/**
 * Every record the demo serves, from the fixtures or made in the demo, has an id with this
 * prefix, and no real record does.
 */
const DEMO_RECORD_ID_PREFIX = "demo_";

/** Whether an id names one of the demo's records rather than a real one. */
export function isDemoRecordId(id: string): boolean {
  return id.startsWith(DEMO_RECORD_ID_PREFIX);
}
