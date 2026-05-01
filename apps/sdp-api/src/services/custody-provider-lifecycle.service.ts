import {
  type CustodyProvider,
  canProviderCreateWallet,
  canProviderDeleteWallet,
  canProviderSign,
} from "@/services/custody/providers";
import { SigningError } from "@/services/ports";

export function custodyProviderCanSign(provider: CustodyProvider): boolean {
  return canProviderSign(provider);
}

export function assertCustodyProviderCanSign(provider: CustodyProvider): void {
  if (!custodyProviderCanSign(provider)) {
    throw new SigningError(
      `Provider does not support transaction signing: ${provider}`,
      "INVALID_REQUEST"
    );
  }
}

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

export function shouldSetCustodyScopeDefault(input: {
  candidateProvider: CustodyProvider;
  currentDefaultProvider: CustodyProvider | null;
}): boolean {
  if (!custodyProviderCanSign(input.candidateProvider)) {
    return false;
  }

  if (!input.currentDefaultProvider) {
    return true;
  }

  return !custodyProviderCanSign(input.currentDefaultProvider);
}
