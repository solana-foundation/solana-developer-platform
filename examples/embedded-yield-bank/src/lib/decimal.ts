const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;

export function isPositiveDecimal(value: string): boolean {
  return /^(?=.*[1-9])\d+(\.\d+)?$/.test(value);
}

function decimalScale(value: string): number {
  return value.split(".")[1]?.length ?? 0;
}

/** Exact unsigned decimal string to integer atoms at the given scale. */
function toAtoms(value: string, decimals: number): bigint {
  if (!DECIMAL_PATTERN.test(value))
    throw new Error(`Invalid decimal value: ${value}`);
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) {
    throw new Error(`${value} has more than ${decimals} decimal places`);
  }
  return BigInt(`${whole}${fraction.padEnd(decimals, "0")}`);
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
