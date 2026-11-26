import {
  CUSTODY_PROVIDER_CAPABILITIES,
  type CustodyProvider as SharedCustodyProvider,
} from "@sdp/types/custody";

export function canProviderSign(provider: SharedCustodyProvider): boolean {
  return CUSTODY_PROVIDER_CAPABILITIES[provider].supportsSigning;
}

export function canProviderCreateWallet(provider: SharedCustodyProvider): boolean {
  return CUSTODY_PROVIDER_CAPABILITIES[provider].supportsAdditionalWalletCreation;
}

export function canProviderDeleteWallet(provider: SharedCustodyProvider): boolean {
  return CUSTODY_PROVIDER_CAPABILITIES[provider].supportsWalletDeletion;
}
