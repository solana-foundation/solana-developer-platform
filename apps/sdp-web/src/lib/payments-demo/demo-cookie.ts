/**
 * Holds the id of the project whose Payments screens show demo data. Naming the project means
 * switching to another one (a production project included) turns the demo off by itself.
 */
export const PAYMENTS_DEMO_COOKIE_NAME = "sdp-payments-demo";

export const PAYMENTS_PATH_PREFIX = "/dashboard/payments";

/** Whether a dashboard path is a Payments screen. */
export function isPaymentsPath(pathname: string | null | undefined): boolean {
  return (
    pathname === PAYMENTS_PATH_PREFIX || Boolean(pathname?.startsWith(`${PAYMENTS_PATH_PREFIX}/`))
  );
}
