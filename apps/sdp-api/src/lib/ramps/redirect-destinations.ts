import { checkRampDestination, type RampDestinationRejection } from "@sdp/types/ramp-destinations";
import { badRequest } from "@/lib/errors";

const REDIRECT_REJECTION_MESSAGES: Record<RampDestinationRejection, string> = {
  not_a_url: "redirectUrl must be an absolute URL.",
  protocol_relative: "redirectUrl must not be protocol-relative.",
  insecure_scheme: "redirectUrl must use https.",
  embedded_credentials: "redirectUrl must not embed credentials.",
  host_not_approved:
    "redirectUrl host is not approved. Add it to RAMP_REDIRECT_ALLOWED_HOSTS to allow it.",
};

/** Parses the comma-separated exact-host allowlist for tenant ramp redirects. */
export function approvedRampRedirectHosts(env: { RAMP_REDIRECT_ALLOWED_HOSTS?: string }): string[] {
  return (env.RAMP_REDIRECT_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host.length > 0);
}

/**
 * Tenant-supplied redirect URLs get signed into provider checkout pages, so a
 * hostile value becomes an open redirect from a trusted provider origin. Every
 * provided redirectUrl must be HTTPS on an operator-approved host; with no
 * allowlist configured, every redirectUrl is rejected — fail closed.
 */
export function assertApprovedRampRedirectUrl(
  env: { RAMP_REDIRECT_ALLOWED_HOSTS?: string },
  redirectUrl: string | undefined
): void {
  if (redirectUrl === undefined) {
    return;
  }
  const result = checkRampDestination(redirectUrl, approvedRampRedirectHosts(env));
  if (!result.ok) {
    throw badRequest(REDIRECT_REJECTION_MESSAGES[result.reason]);
  }
}
