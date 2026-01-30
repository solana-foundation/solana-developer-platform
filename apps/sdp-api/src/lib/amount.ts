export const MAX_SAFE_BASE_UNITS = BigInt(Number.MAX_SAFE_INTEGER);

export class AmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmountError";
  }
}

const isDigit = (char: string) => char >= "0" && char <= "9";

export const isDecimalString = (value: string): boolean => {
  if (!value) {
    return false;
  }

  let hasDigit = false;
  let seenDot = false;

  for (const char of value) {
    if (char === ".") {
      if (seenDot) {
        return false;
      }
      seenDot = true;
      continue;
    }

    if (!isDigit(char)) {
      return false;
    }

    hasDigit = true;
  }

  return hasDigit;
};

const normalizeDecimalParts = (value: string): { whole: string; fraction: string } => {
  const [wholeRaw = "", fractionRaw = ""] = value.split(".");
  const whole = wholeRaw.length ? wholeRaw : "0";
  const fraction = fractionRaw ?? "";
  return { whole, fraction };
};

export const parseDecimalAmount = (value: string, decimals: number): bigint => {
  const normalized = value.trim();

  if (!isDecimalString(normalized)) {
    throw new AmountError("Invalid decimal amount");
  }

  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new AmountError("Invalid decimals configuration");
  }

  const { whole, fraction } = normalizeDecimalParts(normalized);

  if (fraction.length > decimals) {
    throw new AmountError("Amount has too many decimal places");
  }

  const paddedFraction = fraction.padEnd(decimals, "0");
  const combined = `${whole}${paddedFraction}`;
  let startIndex = 0;
  while (startIndex < combined.length && combined[startIndex] === "0") {
    startIndex += 1;
  }
  const sanitized = startIndex >= combined.length ? "0" : combined.slice(startIndex);

  return BigInt(sanitized);
};

export const formatDecimalAmount = (value: string | bigint, decimals: number): string => {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new AmountError("Invalid decimals configuration");
  }

  const bigintValue = typeof value === "bigint" ? value : BigInt(value || "0");
  const negative = bigintValue < 0n;
  const absolute = negative ? -bigintValue : bigintValue;

  let digits = absolute.toString();

  if (decimals === 0) {
    return `${negative ? "-" : ""}${digits}`;
  }

  if (digits.length <= decimals) {
    digits = digits.padStart(decimals + 1, "0");
  }

  const whole = digits.slice(0, -decimals);
  let fraction = digits.slice(-decimals);

  let trimIndex = fraction.length;
  while (trimIndex > 0 && fraction[trimIndex - 1] === "0") {
    trimIndex -= 1;
  }

  fraction = fraction.slice(0, trimIndex);

  const formatted = fraction.length ? `${whole}.${fraction}` : whole;
  return `${negative ? "-" : ""}${formatted}`;
};

export const toMosaicAmount = (value: string, decimals: number): number => {
  const baseUnits = parseDecimalAmount(value, decimals);

  if (baseUnits > MAX_SAFE_BASE_UNITS) {
    throw new AmountError("Amount is too large for Mosaic minting");
  }

  const formatted = formatDecimalAmount(baseUnits, decimals);
  const amount = Number(formatted);

  if (!Number.isFinite(amount)) {
    throw new AmountError("Amount is not a valid number");
  }

  const roundTrip = parseDecimalAmount(amount.toString(), decimals);
  if (roundTrip !== baseUnits) {
    throw new AmountError("Amount loses precision when converted to a number");
  }

  return amount;
};
