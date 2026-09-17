/** Annual percentage yield surfaced on the demo's "Earn" button. */
export const EARN_APY = 0.0843;

/** Fast-forward horizon shown in the balance chart, in days. */
export const EARN_DAYS = 30;

/** Demo USDC balance the customer starts with. */
export const EARN_PRINCIPAL = 12_500;

const COMPOUNDING_PERIODS_PER_YEAR = 365;

/**
 * Deterministic day-to-day rate variation. Real lending yield drifts with
 * borrower utilization, so the fast-forward should wobble around its average
 * instead of compounding in a straight line. Returns a fraction in
 * [-0.55, 0.55] of the base daily rate — always positive after the wobble —
 * and the seeded hash keeps every replay of the animation on the same
 * history.
 */
export function rateWobble(day: number): number {
  const jitter = Math.sin(day * 12.9898) * 43758.5453;
  return (jitter - Math.floor(jitter)) * 1.1 - 0.55;
}

function dailyRate(apy: number, day: number): number {
  return (apy / COMPOUNDING_PERIODS_PER_YEAR) * (1 + rateWobble(day));
}

/**
 * Balance after `days` of daily-compounded yield whose rate fluctuates with
 * utilization: every day accrues a positive amount, but by varying amounts.
 * Fractional days apply the current day's rate pro rata, so the animation can
 * sweep continuously between days.
 */
export function balanceAfterDays(
  principal: number,
  apy: number,
  days: number
): number {
  if (days <= 0) return principal;
  let balance = principal;
  const whole = Math.floor(days);
  for (let day = 1; day <= whole; day += 1) {
    balance *= 1 + dailyRate(apy, day);
  }
  return balance * (1 + dailyRate(apy, whole + 1) * (days - whole));
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
