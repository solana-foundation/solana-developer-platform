/**
 * Trusted-destination checks for ramp redirect and widget URLs.
 *
 * Every URL a ramp flow navigates to or embeds — provider widget/hosted URLs,
 * provider verification links, and tenant-supplied redirect targets — must be
 * HTTPS on an exactly approved host. Protocol-relative and active-content
 * URLs (javascript:, data:, blob:) fail closed, as do URLs with embedded
 * credentials.
 */

/** MoonPay hosted-checkout hosts (production and sandbox, buy and sell). */
export const MOONPAY_HOSTED_APPROVED_HOSTS = [
  "buy.moonpay.com",
  "sell.moonpay.com",
  "buy-sandbox.moonpay.com",
  "sell-sandbox.moonpay.com",
] as const;

export type RampDestinationRejection =
  | "not_a_url"
  | "protocol_relative"
  | "insecure_scheme"
  | "embedded_credentials"
  | "host_not_approved";

export type RampDestinationCheck =
  | { ok: true; url: URL }
  | { ok: false; reason: RampDestinationRejection };

/**
 * Validates a ramp destination URL. Pass `approvedHosts` to additionally pin
 * the hostname to an exact allowlist (an empty list rejects every host —
 * fail closed); pass `null` only for destinations whose host set genuinely
 * cannot be enumerated (e.g. provider KYC links), keeping the scheme checks.
 */
export function checkRampDestination(
  rawUrl: string,
  approvedHosts: readonly string[] | null
): RampDestinationCheck {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "not_a_url" };
  }
  if (trimmed.startsWith("//")) {
    return { ok: false, reason: "protocol_relative" };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: "not_a_url" };
  }
  if (url.protocol !== "https:") {
    return { ok: false, reason: "insecure_scheme" };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "embedded_credentials" };
  }
  if (approvedHosts !== null) {
    const hostname = url.hostname.toLowerCase();
    if (!approvedHosts.some((host) => host.toLowerCase() === hostname)) {
      return { ok: false, reason: "host_not_approved" };
    }
  }
  return { ok: true, url };
}

export function isTrustedRampDestination(
  rawUrl: string,
  approvedHosts: readonly string[] | null
): boolean {
  return checkRampDestination(rawUrl, approvedHosts).ok;
}
