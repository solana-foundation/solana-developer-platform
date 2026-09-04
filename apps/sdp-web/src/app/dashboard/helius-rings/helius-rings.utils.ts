/**
 * Presentation helpers for the Helius Rings workspace. Timestamps take the
 * locale the i18n provider resolved, not the runtime default, so a server
 * render and its hydration agree.
 */

import {
  RINGS_ALLOWLISTED_ASSETS,
  RINGS_HEALTH_COMPONENTS,
  type RingsHealth,
  type RingsHealthComponent,
  type RingsOperationState,
} from "./helius-rings.data";

/**
 * States something is actively working through, so the row will change on its
 * own and is worth both a spinner and another poll.
 *
 * `approval_required` is deliberately absent: it is waiting on a person, not on
 * the pipeline, and a spinner there would turn indefinitely. Terminal states
 * are absent for the obvious reason.
 */
const SETTLING: ReadonlySet<RingsOperationState> = new Set<RingsOperationState>([
  "preparing",
  "proving",
  "ready_to_sign",
  "submitted",
  "indexing",
]);

export function isSettling(state: RingsOperationState): boolean {
  return SETTLING.has(state);
}

export function formatWhen(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
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

// Whole part with optional fraction. Reject a bare `.` or a leading `.`.
const AMOUNT_DECIMAL = /^\d+(?:\.\d+)?$/;

/**
 * Parses a user-typed decimal amount ("1.01") into its uint64 base-unit form
 * ("1010000000" at 9 decimals). Returns `null` for anything that would need
 * more fractional digits than the mint carries — refusing dust is safer than
 * silently truncating it.
 */
export function parseDecimalToBaseUnits(decimal: string, decimals: number): string | null {
  if (!AMOUNT_DECIMAL.test(decimal)) return null;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) return null;

  const [whole, fraction = ""] = decimal.split(".");
  if (fraction.length > decimals) return null;

  const combined = `${whole}${fraction.padEnd(decimals, "0")}`.replace(/^0+(?=\d)/, "");
  return combined === "" ? "0" : combined;
}

/**
 * Renders a stored amount as "<value> <symbol>" at the mint's scale, or the raw
 * base-unit digits if the mint is unknown to us. Never a bare number, so the
 * operator can tell 1 lamport from 1 SOL at a glance.
 */
export function formatAssetAmount(amountRaw: string | null, assetMint: string | null): string {
  if (!amountRaw) return "—";
  const asset = assetMint
    ? RINGS_ALLOWLISTED_ASSETS.find((entry) => entry.mint === assetMint)
    : undefined;
  if (!asset) return amountRaw;
  const formatted = formatBaseUnits(amountRaw, asset.decimals);
  return formatted === null ? amountRaw : `${formatted} ${asset.symbol}`;
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

/**
 * Enough of an operation id to tell two apart in a lineage label. The prefix is
 * shared by every row, so only the tail distinguishes them.
 */
export function shortenOperationId(operationId: string, tail = 8): string {
  return operationId.length <= tail ? operationId : `…${operationId.slice(-tail)}`;
}
