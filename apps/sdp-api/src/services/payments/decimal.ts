import { isDecimalString } from "@/lib/amount";
import { badRequest } from "@/lib/errors";

function parseDecimalParts(value: string): { whole: string; fraction: string } {
  const normalized = value.trim();
  if (!isDecimalString(normalized)) {
    throw badRequest("Invalid amount format");
  }

  const [wholeRaw = "", fractionRaw = ""] = normalized.split(".");
  const whole = (wholeRaw || "0").replace(/^0+(?=\d)/, "");
  let fraction = fractionRaw ?? "";
  fraction = fraction.replace(/0+$/, "");

  return {
    whole: whole.length > 0 ? whole : "0",
    fraction,
  };
}

export function compareDecimalAmounts(left: string, right: string): number {
  const leftParts = parseDecimalParts(left);
  const rightParts = parseDecimalParts(right);

  if (leftParts.whole.length !== rightParts.whole.length) {
    return leftParts.whole.length < rightParts.whole.length ? -1 : 1;
  }

  if (leftParts.whole !== rightParts.whole) {
    return leftParts.whole < rightParts.whole ? -1 : 1;
  }

  const scale = Math.max(leftParts.fraction.length, rightParts.fraction.length);
  const leftFraction = leftParts.fraction.padEnd(scale, "0");
  const rightFraction = rightParts.fraction.padEnd(scale, "0");

  if (leftFraction === rightFraction) {
    return 0;
  }

  return leftFraction < rightFraction ? -1 : 1;
}

export function sumDecimalAmounts(amounts: string[]): string {
  if (amounts.length === 0) {
    return "0";
  }

  const parsed = amounts.map(parseDecimalParts);
  const scale = parsed.reduce((max, entry) => Math.max(max, entry.fraction.length), 0);

  const total = parsed.reduce((acc, entry) => {
    const combined = `${entry.whole}${entry.fraction.padEnd(scale, "0")}`;
    return acc + BigInt(combined);
  }, 0n);

  if (scale === 0) {
    return total.toString();
  }

  const digits = total.toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, -scale).replace(/^0+(?=\d)/, "") || "0";
  const fraction = digits.slice(-scale).replace(/0+$/, "");

  return fraction ? `${whole}.${fraction}` : whole;
}

export function addDecimalAmounts(left: string, right: string): string {
  return sumDecimalAmounts([left, right]);
}

export function getUtcDayWindow(now: Date): { start: string; end: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
  };
}
