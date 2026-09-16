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
 * Opens a provider-supplied link (KYC/verification/terms pages) in a new tab.
 * Their host set cannot be enumerated, but anything that is not a plain HTTPS
 * URL — protocol-relative, javascript:/data:, embedded credentials — fails
 * closed and is never opened.
 */
export function openExternalRampUrl(url: string): void {
  if (!isTrustedRampDestination(url, null)) {
    return;
  }
  window.open(url, "_blank", "noopener");
}

/**
 * Opens a BVNK agreement or privacy-policy link in a new tab, pinned to the
 * approved help-centre host. The Sumsub verification link is opened via
 * `openExternalRampUrl` (offramp-rail.tsx) and is not host-pinned by design.
 */
export function openBvnkCustomerLink(url: string): void {
  if (!isTrustedRampDestination(url, BVNK_CUSTOMER_LINK_APPROVED_HOSTS)) {
    return;
  }
  window.open(url, "_blank", "noopener");
}
