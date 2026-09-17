import {
  BVNK_CUSTOMER_LINK_APPROVED_HOSTS,
  COINBASE_HOSTED_APPROVED_HOSTS,
  isTrustedRampDestination,
  MONEYGRAM_WIDGET_APPROVED_HOSTS,
  MOONPAY_HOSTED_APPROVED_HOSTS,
} from "@sdp/types/ramp-destinations";

export {
  BVNK_CUSTOMER_LINK_APPROVED_HOSTS,
  COINBASE_HOSTED_APPROVED_HOSTS,
  isTrustedRampDestination,
  MONEYGRAM_WIDGET_APPROVED_HOSTS,
  MOONPAY_HOSTED_APPROVED_HOSTS,
};

/**
 * Opens a provider-supplied link (KYC/verification/terms pages) in a new tab
 * after the trust model check passes. `approvedHosts` pins the host set; null
 * leaves it unpinned. Anything that is not a plain HTTPS URL — protocol-
 * relative, javascript:/data:, embedded credentials — fails closed and is
 * never opened.
 *
 * @param url - The provider-supplied URL to open.
 * @param approvedHosts - Hosts the link is pinned to, or null to allow any HTTPS host.
 */
function openExternalRampDestination(url: string, approvedHosts: readonly string[] | null): void {
  if (!isTrustedRampDestination(url, approvedHosts)) {
    return;
  }
  window.open(url, "_blank", "noopener");
}

/** Opens an unpinned provider link (e.g. the Sumsub verification page) in a new tab. */
export function openExternalRampUrl(url: string): void {
  openExternalRampDestination(url, null);
}

/**
 * Opens a BVNK agreement or privacy-policy link in a new tab, pinned to the
 * approved BVNK document hosts (help centre + corporate site). The Sumsub
 * verification link is opened via `openExternalRampUrl` (offramp-rail.tsx) and
 * is not host-pinned by design.
 */
export function openBvnkCustomerLink(url: string): void {
  openExternalRampDestination(url, BVNK_CUSTOMER_LINK_APPROVED_HOSTS);
}
