/**
 * Holds the id of the project whose Payments and Issuance screens run in demo mode. Naming the project means
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

export const PAYMENTS_PATH_PREFIX = "/dashboard/payments";

export const ISSUANCE_PATH_PREFIX = "/dashboard/issuance";

function isUnder(pathname: string | null | undefined, prefix: string): boolean {
  return pathname === prefix || Boolean(pathname?.startsWith(`${prefix}/`));
}

/**
 * Whether a dashboard path is one the demo covers: the Payments and Issuance screens, which share
 * one switch and one world (Issuance signs with the Payments demo's wallets).
 */
export function isDemoPath(pathname: string | null | undefined): boolean {
  return isUnder(pathname, PAYMENTS_PATH_PREFIX) || isUnder(pathname, ISSUANCE_PATH_PREFIX);
}

/** Whether a cookie is one of the demo session's chunks. */
export function isDemoSessionCookie(name: string): boolean {
  return name === DEMO_SESSION_COOKIE_PREFIX || name.startsWith(`${DEMO_SESSION_COOKIE_PREFIX}.`);
}
