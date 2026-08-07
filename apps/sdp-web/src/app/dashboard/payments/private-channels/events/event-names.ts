import { shortenAddress } from "../../payments-overview.utils";

export type EventNames = Readonly<Record<string, string>>;

/** Resolved name, or undefined when the reference is missing or unknown. */
export function nameOf(names: EventNames, value: string | null | undefined): string | undefined {
  return value ? names[value] : undefined;
}

/**
 * Display name when known, otherwise the shortened value. A present reference
 * always has a label; a missing one returns undefined so callers can keep
 * optional chaining.
 */
export function labelFor(names: EventNames, value: string): string;
export function labelFor(names: EventNames, value: string | null | undefined): string | undefined;
export function labelFor(names: EventNames, value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  return names[value] ?? shortenAddress(value);
}
