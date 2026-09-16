const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;

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

  const [whole, fraction = ""] = quote.split(".");
  if (fraction.length > decimals) {
    throw new Error("Provider quote exceeds its reported decimal scale");
  }

  const atoms = BigInt(`${whole}${fraction.padEnd(decimals, "0")}`);
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
    const [whole, fraction = ""] = unsigned.split(".");
    return { negative, whole, fraction };
  });
  const decimals = parsed.reduce(
    (maximum, value) => Math.max(maximum, value.fraction.length),
    0
  );
  const total = parsed.reduce((sum, value) => {
    const atoms = BigInt(
      `${value.whole}${value.fraction.padEnd(decimals, "0")}`
    );
    return sum + (value.negative ? -atoms : atoms);
  }, 0n);
  const negative = total < 0n;
  const formatted = formatAtoms(negative ? -total : total, decimals);
  return negative ? `-${formatted}` : formatted;
}
