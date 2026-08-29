import { type PartnerFamily, partnerPersonalDataAllowlist } from "@sdp/types/partner-intake";
import { internalError } from "../errors";

/**
 * The PII-minimization half of the partner security intake (threat SDP-018).
 *
 * Most ramp payloads are assembled field by field from a declared requirement
 * spec, so they cannot carry a field nobody declared — Lightspark's payout
 * `accountInfo` is built that way, and Mural's and Stripe's handlers no longer
 * touch identity at all. The exception is a payload forwarded as an object:
 * BVNK's `individual` is typed `Record<string, unknown>` and passed straight
 * into the request body. `collectedData` at the API boundary is an open
 * `Record<string, string>`, so "whatever the caller sent" is a real shape a
 * future builder could hand to a partner by accident.
 *
 * This is the check for that case: every leaf in the payload must appear in the
 * partner's `personalDataFieldAllowlist`.
 *
 * ## Why it refuses instead of stripping
 *
 * Stripping would be the quiet option, and quiet is what makes a control
 * useless. These payloads are built by SDP's own code from a known spec, so an
 * undeclared field means the builder and the register disagree — a bug, and
 * usually the interesting kind. Refusing surfaces it in the test that covers the
 * builder; stripping would let it ship, then remove a field the partner needed
 * and produce a verification failure nobody traces back to here.
 *
 * ## Why the message names paths and never values
 *
 * The whole point is that these fields are sensitive. The error carries the
 * offending paths so the mismatch is diagnosable, and never the values, so the
 * refusal cannot become the leak.
 */

/** Dotted paths to every leaf in the payload, in insertion order. */
function leafPaths(value: unknown, prefix: string, into: string[]): void {
  if (value === undefined) {
    // A key whose value is undefined never reaches the wire.
    return;
  }

  // Arrays and null are leaves: their contents are values, not named fields.
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    into.push(prefix);
    return;
  }

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    leafPaths(nested, prefix ? `${prefix}.${key}` : key, into);
  }
}

/**
 * Returns `payload` unchanged when every field in it is declared for the
 * partner, and throws otherwise.
 *
 * @throws SdpPaymentsError INTERNAL_ERROR when the partner does not declare a
 * forwarded personal-data payload at all, or when the payload carries a field
 * the register does not list.
 */
export function enforcePartnerFieldAllowlist<T extends Record<string, unknown>>(
  family: PartnerFamily,
  providerId: string,
  payload: T
): T {
  const allowlist = partnerPersonalDataAllowlist(family, providerId);
  if (!allowlist) {
    throw internalError(
      `${providerId} does not declare a forwarded personal-data payload in the partner intake register; record one before sending identity fields.`
    );
  }

  const paths: string[] = [];
  leafPaths(payload, "", paths);

  const allowed = new Set(allowlist);
  const undeclared = paths.filter((path) => !allowed.has(path));
  if (undeclared.length > 0) {
    throw internalError(
      `${providerId} payload carries fields the partner intake register does not allow: ${undeclared.join(", ")}.`
    );
  }

  return payload;
}
