const USD_STABLECOINS = new Set(["USDC", "USDG", "PYUSD", "USDT"]);

/** "$" for dollar stablecoins, otherwise nothing: never imply a peg we lack. */
export function currencyPrefix(symbol: string): string {
  return USD_STABLECOINS.has(symbol) ? "$" : "";
}

/** The unsigned digits a money figure renders with: sub-cent values get four places. */
function displayDigits(magnitude: number): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: magnitude > 0 && magnitude < 0.01 ? 4 : 2,
  }).format(magnitude);
}

function isZeroDigits(digits: string): boolean {
  return !/[1-9]/.test(digits);
}

/**
 * Whether a figure renders as zero, so it may carry no sign: a vault's
 * rounding leaves earnings like -0.000002 that must not read as a loss.
 */
export function roundsToZero(value: string): boolean {
  const amount = Number(value);
  return (
    Number.isFinite(amount) && isZeroDigits(displayDigits(Math.abs(amount)))
  );
}

function amountSign(
  amount: number,
  digits: string,
  signed: boolean
): "" | "-" | "+" {
  if (isZeroDigits(digits)) return "";
  if (amount < 0) return "-";
  return signed ? "+" : "";
}

/**
 * Bank-style money. Dollar stablecoins render as dollars; anything else keeps
 * its ticker so the number is never misread.
 */
export function formatAmount(
  value: string,
  symbol: string,
  options?: { signed?: boolean }
): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  const digits = displayDigits(Math.abs(amount));
  const sign = amountSign(amount, digits, options?.signed === true);
  return USD_STABLECOINS.has(symbol)
    ? `${sign}$${digits}`
    : `${sign}${digits} ${symbol}`;
}

export function formatApy(value: string | undefined): string {
  const apy = Number(value);
  if (value === undefined || !Number.isFinite(apy)) return "Variable APY";
  return `${new Intl.NumberFormat("en-US", {
    style: "percent",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(apy)} APY`;
}

export function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function formatTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}
