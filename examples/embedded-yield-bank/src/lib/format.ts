export function formatMoney(
  value: string | undefined,
  options?: { signed?: boolean }
): string {
  if (value === undefined) return "Not available";
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "Not available";
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: amount < 1 ? 4 : 2,
  }).format(Math.abs(amount));
  if (!options?.signed || amount === 0) return formatted;
  return amount > 0 ? `+${formatted}` : `-${formatted}`;
}

export function formatToken(
  value: string,
  symbol: string,
  maximumFractionDigits = 4
): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return `Not available ${symbol}`;
  return `${new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits,
  }).format(amount)} ${symbol}`;
}

export function formatAccountToken(
  value: string | undefined,
  symbol: string | null,
  options?: { signed?: boolean }
): string {
  if (value === undefined || !symbol) return "Not available";
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "Not available";
  const formatted = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: Math.abs(amount) < 1 ? 4 : 2,
  }).format(Math.abs(amount));
  const sign = options?.signed && amount > 0 ? "+" : amount < 0 ? "-" : "";
  return `${sign}${formatted} ${symbol}`;
}

export function formatApy(value: string | undefined): string {
  if (value === undefined) return "Variable";
  const apy = Number(value);
  if (!Number.isFinite(apy)) return "Variable";
  return new Intl.NumberFormat("en-US", {
    style: "percent",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(apy);
}

export function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 5)}...${address.slice(-5)}`;
}

export function titleCase(value: string): string {
  return value
    .split(/[-_]/)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}
