export function normalizePrivyWalletId(walletId: string): string {
  return walletId.startsWith("privy_") ? walletId : `privy_${walletId}`;
}

export function normalizeCoinbaseCdpWalletId(walletAddress: string): string {
  return walletAddress.startsWith("cdp_") ? walletAddress : `cdp_${walletAddress}`;
}

export function normalizeParaWalletId(walletId: string): string {
  return walletId.startsWith("para_") ? walletId : `para_${walletId}`;
}

export function normalizeTurnkeyWalletId(privateKeyId: string): string {
  return privateKeyId.startsWith("turnkey_") ? privateKeyId : `turnkey_${privateKeyId}`;
}

export function normalizeAnchorageWalletId(walletId: string): string {
  return walletId.startsWith("anchorage_") ? walletId : `anchorage_${walletId}`;
}

export function denormalizeAnchorageWalletId(walletId: string): string {
  return walletId.startsWith("anchorage_") ? walletId.slice("anchorage_".length) : walletId;
}
