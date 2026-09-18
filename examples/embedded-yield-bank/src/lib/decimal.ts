const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;

export function isPositiveDecimal(value: string): boolean {
  return /^(?=.*[1-9])\d+(\.\d+)?$/.test(value);
}

export function decimalScale(value: string): number {
  return value.split(".")[1]?.length ?? 0;
}

/** Exact unsigned decimal string to integer atoms at the given scale. */
export function toAtoms(value: string, decimals: number): bigint {
  if (!DECIMAL_PATTERN.test(value))
    throw new Error(`Invalid decimal value: ${value}`);
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) {
    throw new Error(`${value} has more than ${decimals} decimal places`);
  }
  return BigInt(`${whole}${fraction.padEnd(decimals, "0")}`);
}

export function compareDecimals(left: string, right: string): -1 | 0 | 1 {
  const scale = Math.max(decimalScale(left), decimalScale(right));
  const a = toAtoms(left, scale);
  const b = toAtoms(right, scale);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `left * right / divisor`, rounded down to `outputDecimals`. */
export function multiplyDivideDecimals(
  left: string,
  right: string,
  divisor: string,
  outputDecimals: number
): string {
  if (!isPositiveDecimal(divisor))
    throw new Error("Cannot divide by a zero decimal");
  const leftScale = decimalScale(left);
  const rightScale = decimalScale(right);
  const divisorScale = decimalScale(divisor);
  let numerator = toAtoms(left, leftScale) * toAtoms(right, rightScale);
  let denominator = toAtoms(divisor, divisorScale);
  const shift = divisorScale + outputDecimals - leftScale - rightScale;
  if (shift >= 0) numerator *= 10n ** BigInt(shift);
  else denominator *= 10n ** BigInt(-shift);
  return formatAtoms(numerator / denominator, outputDecimals);
}

export function floorForTolerance(
  quote: string,
  decimals: number,
  toleranceBps: number
): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) {
    throw new Error("Provider returned an unsupported decimal scale");
  }
  if (
    !Number.isInteger(toleranceBps) ||
    toleranceBps < 1 ||
    toleranceBps > 1_000
  ) {
    throw new Error(
      "Slippage tolerance must be between 1 and 1,000 basis points"
    );
  }
  if (!DECIMAL_PATTERN.test(quote)) {
    throw new Error("Provider quote is not a positive decimal");
  }
  if (decimalScale(quote) > decimals) {
    throw new Error("Provider quote exceeds its reported decimal scale");
  }

  const atoms = toAtoms(quote, decimals);
  if (atoms === 0n) throw new Error("Provider quote returned zero output");

  const floored = (atoms * BigInt(10_000 - toleranceBps)) / 10_000n || 1n;
  return formatAtoms(floored, decimals);
}

export function formatAtoms(atoms: bigint, decimals: number): string {
  if (decimals === 0) return atoms.toString();
  const digits = atoms.toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, -decimals);
  const fraction = digits.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

export function addDecimals(values: readonly string[]): string {
  const parsed = values.map((value) => {
    if (!/^-?\d+(\.\d+)?$/.test(value))
      throw new Error(`Invalid decimal value: ${value}`);
    const negative = value.startsWith("-");
    const unsigned = negative ? value.slice(1) : value;
    return { negative, unsigned };
  });
  const decimals = parsed.reduce(
    (maximum, value) => Math.max(maximum, decimalScale(value.unsigned)),
    0
  );
  const total = parsed.reduce((sum, value) => {
    const atoms = toAtoms(value.unsigned, decimals);
    return sum + (value.negative ? -atoms : atoms);
  }, 0n);
  const negative = total < 0n;
  const formatted = formatAtoms(negative ? -total : total, decimals);
  return negative ? `-${formatted}` : formatted;
}
