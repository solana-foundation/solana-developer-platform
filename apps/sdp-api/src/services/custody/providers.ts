/**
 * Canonical custody provider definitions and capability flags.
 */

export const CUSTODY_PROVIDERS = [
  "fireblocks",
  "privy",
  "coinbase_cdp",
  "para",
  "turnkey",
  "dfns",
  "anchorage",
  "local",
] as const;

export type CustodyProvider = (typeof CUSTODY_PROVIDERS)[number];

export const FULL_SIGNING_CUSTODY_PROVIDERS = [
  "fireblocks",
  "privy",
  "coinbase_cdp",
  "para",
  "turnkey",
  "dfns",
] as const;

export type FullSigningCustodyProvider = (typeof FULL_SIGNING_CUSTODY_PROVIDERS)[number];

export interface CustodyProviderCapabilities {
  canSign: boolean;
  canCreateWallet: boolean;
  canDeleteWallet: boolean;
}

export const CUSTODY_PROVIDER_CAPABILITIES: Record<CustodyProvider, CustodyProviderCapabilities> = {
  fireblocks: {
    canSign: true,
    canCreateWallet: false,
    canDeleteWallet: false,
  },
  privy: {
    canSign: true,
    canCreateWallet: true,
    canDeleteWallet: false,
  },
  coinbase_cdp: {
    canSign: true,
    canCreateWallet: true,
    canDeleteWallet: false,
  },
  para: {
    canSign: true,
    canCreateWallet: true,
    canDeleteWallet: false,
  },
  turnkey: {
    canSign: true,
    canCreateWallet: true,
    canDeleteWallet: false,
  },
  dfns: {
    canSign: true,
    canCreateWallet: true,
    canDeleteWallet: false,
  },
  anchorage: {
    canSign: false,
    canCreateWallet: true,
    canDeleteWallet: true,
  },
  local: {
    canSign: true,
    canCreateWallet: false,
    canDeleteWallet: false,
  },
};

export function isCustodyProvider(value: string): value is CustodyProvider {
  return (CUSTODY_PROVIDERS as readonly string[]).includes(value);
}

export function canProviderSign(provider: CustodyProvider): boolean {
  return CUSTODY_PROVIDER_CAPABILITIES[provider].canSign;
}

export function canProviderCreateWallet(provider: CustodyProvider): boolean {
  return CUSTODY_PROVIDER_CAPABILITIES[provider].canCreateWallet;
}

export function canProviderDeleteWallet(provider: CustodyProvider): boolean {
  return CUSTODY_PROVIDER_CAPABILITIES[provider].canDeleteWallet;
}
