/** Annual percentage yield surfaced on the demo's "Earn" button. */
export const EARN_APY = 0.0843;

/** Fast-forward horizon shown in the balance chart, in days. */
export const EARN_DAYS = 30;

/** Demo USDC balance the customer starts with. */
export const EARN_PRINCIPAL = 12_500;

const COMPOUNDING_PERIODS_PER_YEAR = 365;

/**
 * Balance after `days` of daily-compounded yield. Fractional days are allowed
 * so the fast-forward animation can sweep continuously between days.
 */
export function balanceAfterDays(
  principal: number,
  apy: number,
  days: number
): number {
  return principal * (1 + apy / COMPOUNDING_PERIODS_PER_YEAR) ** days;
}

/** One balance point per day, from day 0 through day `days`, inclusive. */
export function yieldSeries(
  principal: number,
  apy: number,
  days: number
): number[] {
  return Array.from({ length: days + 1 }, (_, day) =>
    balanceAfterDays(principal, apy, day)
  );
}
