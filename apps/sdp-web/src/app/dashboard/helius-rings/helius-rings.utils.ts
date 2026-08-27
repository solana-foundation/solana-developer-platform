/**
 * Presentation helpers for the Helius Rings workspace.
 *
 * Timestamps are formatted with the locale the i18n provider resolved rather
 * than the runtime's default, so a server render and its hydration agree.
 * Mirrors `formatWhen` in the private-channels events list.
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

/**
 * SPL mints store `decimals` in a u8, so anything above this is not a scale —
 * and padding to it would allocate against a number the API should never send.
 */
const MAX_DECIMALS = 255;

/**
 * Renders a uint64 base-unit amount at its mint's scale, exactly.
 *
 * The amount never becomes a JavaScript number: `BigInt` canonicalizes the
 * integer and the point is placed by slicing digits, so `18446744073709551615`
 * survives intact where a float would have rounded it. Trailing zeroes in the
 * fraction are dropped — `1500000` at 6 decimals is `1.5`, not `1.500000` — and
 * a fraction that drops entirely leaves no stray point.
 *
 * Returns `null` for anything it cannot render exactly, so a caller shows "no
 * figure" rather than a `0` it made up.
 */
export function formatBaseUnits(amountRaw: string, decimals: number): string | null {
  if (!BASE_UNITS.test(amountRaw)) return null;
  // `decimals` is a scale, not an amount — it arrives as a JSON number and is
  // only ever compared and used as a slice length. The amount stays a string.
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) return null;

  const digits = BigInt(amountRaw).toString();
  if (decimals === 0) return digits;

  const padded = digits.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return fraction === "" ? whole : `${whole}.${fraction}`;
}

/**
 * How a shielded amount may be shown.
 *
 * `baseUnits` is a distinct outcome rather than a scale of zero because the two
 * produce identical digits and only differ in what they claim: one says the
 * mint has no fraction, the other says nobody knows where the point goes. The
 * caller has to label them differently, so it has to be able to tell them apart.
 */
export type ShieldedAmount =
  | { scale: "exact"; text: string }
  | { scale: "baseUnits"; text: string }
  | { scale: "unrenderable" };

/**
 * Reads a balance at its mint's scale when the API reported one, and as an
 * exact base-unit count when it did not.
 */
export function readShieldedAmount(amountRaw: string, decimals: number | null): ShieldedAmount {
  const text = formatBaseUnits(amountRaw, decimals ?? 0);
  if (text === null) return { scale: "unrenderable" };
  return { scale: decimals === null ? "baseUnits" : "exact", text };
}

/**
 * The reason the API recorded for one health component, if it recorded one.
 *
 * The rows are flattened into a single `detail` map keyed `<component>.reason`,
 * so this is the one place that spells that convention. An absent entry means
 * the probe offered no explanation — never that the component is healthy.
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
 * The reasons behind every component that is not green, one entry per distinct
 * reason.
 *
 * Grouping is the point. A deployment with an unset environment variable
 * records the same sentence against all four components, and four identical
 * paragraphs read as four separate problems; one line naming all four reads as
 * the single problem it is.
 *
 * Components with no recorded reason are left out entirely — the red badge
 * already says "not green", and a placeholder line would add nothing an
 * operator could act on.
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
 * Middle-ellipsis for a shielded address in a table cell.
 *
 * The full commitment stays on the copy control and the `title`; this is only
 * the scan form. Shorter than a Solana pubkey lead/tail because these strings
 * are roughly twice as long and blew the wallets table out of the viewport.
 */
export function shortenShieldedAddress(address: string, lead = 6, tail = 4): string {
  if (address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}
