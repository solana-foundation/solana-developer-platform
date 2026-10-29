import { canProviderCreateWallet, canProviderDeleteWallet } from "@sdp/custody/providers";
import { SigningError } from "@sdp/custody/signing";
import type { CustodyProvider } from "@sdp/types/custody";

export function assertCustodyProviderCanCreateWallet(provider: CustodyProvider): void {
  if (!canProviderCreateWallet(provider)) {
    throw new SigningError(
      `Wallet provisioning not supported for provider: ${provider}`,
      "INVALID_REQUEST"
    );
  }
}

export function assertCustodyProviderCanDeleteWallet(provider: CustodyProvider): void {
  if (!canProviderDeleteWallet(provider)) {
    throw new SigningError(
      `Wallet deletion not supported for provider: ${provider}`,
      "INVALID_REQUEST"
    );
  }
}
