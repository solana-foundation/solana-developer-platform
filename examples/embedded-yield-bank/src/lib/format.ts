const USD_STABLECOINS = new Set(["USDC", "USDG", "PYUSD", "USDT"]);

/** "$" for dollar stablecoins, otherwise nothing: never imply a peg we lack. */
export function currencyPrefix(symbol: string): string {
  return USD_STABLECOINS.has(symbol) ? "$" : "";
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
  const magnitude = Math.abs(amount);
  const digits = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: magnitude > 0 && magnitude < 0.01 ? 4 : 2,
  }).format(magnitude);
  const sign = amount < 0 ? "-" : options?.signed && amount > 0 ? "+" : "";
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
