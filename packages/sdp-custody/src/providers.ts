import {
  CUSTODY_PROVIDER_CAPABILITIES,
  type CustodyProvider as SharedCustodyProvider,
} from "@sdp/types";

export type {
  CustodyProvider,
  CustodyProviderCapabilities,
  FullSigningCustodyProvider,
} from "@sdp/types";
export { FULL_SIGNING_CUSTODY_PROVIDERS } from "@sdp/types";
export { CUSTODY_PROVIDER_CAPABILITIES };

export const CUSTODY_PROVIDERS = [
  "fireblocks",
  "privy",
  "coinbase_cdp",
  "para",
  "turnkey",
  "dfns",
  "ibm_haven",
  "anchorage",
  "utila",
  "local",
] as const satisfies readonly SharedCustodyProvider[];

export function canProviderSign(provider: SharedCustodyProvider): boolean {
  return CUSTODY_PROVIDER_CAPABILITIES[provider].supportsSigning;
}

export function canProviderCreateWallet(provider: SharedCustodyProvider): boolean {
  return CUSTODY_PROVIDER_CAPABILITIES[provider].supportsAdditionalWalletCreation;
}

export function canProviderDeleteWallet(provider: SharedCustodyProvider): boolean {
  return CUSTODY_PROVIDER_CAPABILITIES[provider].supportsWalletDeletion;
}
