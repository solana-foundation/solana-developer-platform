/**
 * Presentation helpers for the Helius Rings workspace. Timestamps take the
 * locale the i18n provider resolved, not the runtime default, so a server
 * render and its hydration agree.
 */

import {
  RINGS_HEALTH_COMPONENTS,
  type RingsHealth,
  type RingsHealthComponent,
} from "./helius-rings.data";

export function formatWhen(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function formatTimeOfDay(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(locale, { timeStyle: "medium" });
}

/** Digits only: a shielded amount is an unsigned integer count of base units. */
const BASE_UNITS = /^\d+$/;

/** SPL mints store `decimals` in a u8; padding past it would allocate wildly. */
const MAX_DECIMALS = 255;

/**
 * Renders a uint64 base-unit amount at its mint's scale, exactly: the amount
 * never becomes a JavaScript number, since a float rounds past 2^53. Returns
 * `null` for anything it cannot render exactly, rather than a made-up `0`.
 */
export function formatBaseUnits(amountRaw: string, decimals: number): string | null {
  if (!BASE_UNITS.test(amountRaw)) return null;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) return null;

  const digits = BigInt(amountRaw).toString();
  if (decimals === 0) return digits;

  const padded = digits.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return fraction === "" ? whole : `${whole}.${fraction}`;
}

/**
 * How a shielded amount may be shown. `baseUnits` is distinct from a zero
 * scale: the digits are identical, but only one claims the mint has no
 * fraction, and the caller has to label them differently.
 */
export type ShieldedAmount =
  | { scale: "exact"; text: string }
  | { scale: "baseUnits"; text: string }
  | { scale: "unrenderable" };

/** Reads a balance at its mint's scale, or as base units when none was reported. */
export function readShieldedAmount(amountRaw: string, decimals: number | null): ShieldedAmount {
  const text = formatBaseUnits(amountRaw, decimals ?? 0);
  if (text === null) return { scale: "unrenderable" };
  return { scale: decimals === null ? "baseUnits" : "exact", text };
}

/**
 * The one place that spells the API's `<component>.reason` key convention.
 * Null means no explanation was recorded, never that the component is healthy.
 */
export function healthReason(
  health: RingsHealth | null,
  component: RingsHealthComponent
): string | null {
  return health?.detail?.[`${component}.reason`] ?? null;
}

export interface RingsHealthAlert {
  components: RingsHealthComponent[];
  reason: string;
}

/**
 * One entry per distinct reason behind the components that are not green: an
 * unset environment variable trips all four, and four copies of the same
 * sentence read as four separate problems.
 */
export function healthAlerts(health: RingsHealth | null): RingsHealthAlert[] {
  if (health === null) return [];
  const byReason = new Map<string, RingsHealthAlert>();

  for (const component of RINGS_HEALTH_COMPONENTS) {
    if (health[component] === "green") continue;
    const reason = healthReason(health, component);
    if (reason === null) continue;

    const grouped = byReason.get(reason);
    if (grouped) {
      grouped.components.push(component);
      continue;
    }
    byReason.set(reason, { components: [component], reason });
  }

  return [...byReason.values()];
}

/**
 * Scan form only — the full commitment stays on the copy control and `title`.
 * The lead/tail is shorter than a pubkey's because these strings are twice as
 * long and overflowed the wallets table.
 */
export function shortenShieldedAddress(address: string, lead = 6, tail = 4): string {
  if (address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}
