/** Example payments the homepage's illustrations show settling, in order. */
export const SAMPLE_AMOUNTS = [
  { value: 12_500, asset: "USDC" },
  { value: 840, asset: "USDC" },
  { value: 1_020_000, asset: "USDC" },
  { value: 96.4, asset: "USDC" },
  { value: 25_000, asset: "USDC" },
  { value: 3_300, asset: "EURC" },
  { value: 410, asset: "USDC" },
  { value: 78_000, asset: "USDC" },
] as const;

/** Example routes, as airport-style city codes. */
export const SAMPLE_ROUTES = [
  ["FRA", "SIN"],
  ["LON", "IAD"],
  ["SFO", "TYO"],
  ["AMS", "GRU"],
  ["DXB", "LON"],
  ["NYC", "LAG"],
  ["BOM", "HKG"],
  ["SYD", "SIN"],
] as const;

/** Formats a sample amount for `locale`, e.g. "12,500.00 USDC". */
export function formatSampleAmount(index: number, locale: string): string {
  const amount = SAMPLE_AMOUNTS[index % SAMPLE_AMOUNTS.length];
  const number = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount.value);
  return `${number} ${amount.asset}`;
}

/** A plausible recent Solana slot number, for the confirmations the illustrations show. */
export function sampleSlot(locale: string): string {
  return new Intl.NumberFormat(locale).format(291_044_000 + Math.floor(Math.random() * 9_000));
}
