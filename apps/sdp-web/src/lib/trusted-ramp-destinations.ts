import {
  COINBASE_HOSTED_APPROVED_HOSTS,
  isTrustedRampDestination,
  MONEYGRAM_WIDGET_APPROVED_HOSTS,
  MOONPAY_HOSTED_APPROVED_HOSTS,
} from "@sdp/types/ramp-destinations";

export {
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
