/**
 * The ISO 8601 duration subset a `velocity` rule window may use: `PnD`,
 * `PTnH`, `PTnM`, and combinations such as `P1DT12H`. Each component is a
 * non-negative integer, components appear at most once and in order, and at
 * least one is present. Years, months, weeks, seconds, fractions and signs are
 * rejected so a window always maps to an exact number of milliseconds.
 */
const ISO_DURATION_PATTERN = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/;

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * Parse a rolling-window duration into milliseconds.
 *
 * @param window - The ISO 8601 duration string.
 * @returns The window length in milliseconds, or null when the string is not
 * in the supported subset or names a zero-length window.
 */
export function parseIsoDurationMs(window: string): number | null {
  const match = ISO_DURATION_PATTERN.exec(window);
  if (match === null) {
    return null;
  }
  const [, days, hours, minutes] = match;
  if (days === undefined && hours === undefined && minutes === undefined) {
    return null;
  }
  // A dangling designator (`P1DT`) matches the optional T group with nothing
  // after it; the pattern accepts it, so reject it here.
  if (window.endsWith("T")) {
    return null;
  }
  const total =
    (days === undefined ? 0 : Number(days) * MS_PER_DAY) +
    (hours === undefined ? 0 : Number(hours) * MS_PER_HOUR) +
    (minutes === undefined ? 0 : Number(minutes) * MS_PER_MINUTE);
  if (!Number.isSafeInteger(total) || total <= 0) {
    return null;
  }
  return total;
}

/**
 * Whether a string is a supported, non-empty rolling-window duration.
 *
 * @param window - The candidate duration string.
 * @returns True when {@link parseIsoDurationMs} accepts it.
 */
export function isIsoDuration(window: string): boolean {
  return parseIsoDurationMs(window) !== null;
}
