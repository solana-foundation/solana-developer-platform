/**
 * Turning what someone types into the base units the chain takes.
 *
 * The API takes u64 base units as strings, which is correct for a machine and
 * hostile to a person: "10 USDC" is 10000000, and asking for the second is how
 * you get a trade off by three orders of magnitude. So the form takes the human
 * amount wherever the mint's decimals are known, and converts here.
 *
 * All string arithmetic, never `Number`. A u64 exceeds 2^53, and a float would
 * quietly round the amount of an asset leg.
 */

export type AmountResult =
  | { ok: true; baseUnits: string }
  | { ok: false; reason: "malformed" | "too-precise" };

/**
 * Converts a decimal amount to base units.
 *
 * @param input - What the user typed, e.g. "10.5".
 * @param decimals - The mint's decimals.
 * @returns The base-unit string, or why it could not be converted.
 */
export function toBaseUnits(input: string, decimals: number): AmountResult {
  const trimmed = input.trim();
  if (!/^\d*(\.\d*)?$/.test(trimmed) || trimmed === "" || trimmed === ".") {
    return { ok: false, reason: "malformed" };
  }

  const [whole, fraction = ""] = trimmed.split(".");
  if (fraction.length > decimals) {
    // Silently truncating would move a different amount than the one on screen.
    return { ok: false, reason: "too-precise" };
  }

  const padded = `${whole}${fraction.padEnd(decimals, "0")}`;
  // Strip leading zeros without turning "0" into "".
  const normalized = padded.replace(/^0+(?=\d)/, "");
  return { ok: true, baseUnits: normalized === "" ? "0" : normalized };
}

/**
 * Renders base units back as a decimal amount, for showing a stored value.
 *
 * @param baseUnits - A u64 as a decimal string.
 * @param decimals - The mint's decimals.
 */
export function fromBaseUnits(baseUnits: string, decimals: number): string {
  if (decimals === 0) {
    return baseUnits;
  }
  const padded = baseUnits.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}
