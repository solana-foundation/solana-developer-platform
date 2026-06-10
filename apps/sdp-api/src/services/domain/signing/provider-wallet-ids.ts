export function normalizePrivyWalletId(walletId: string): string {
  return walletId.startsWith("privy_") ? walletId : `privy_${walletId}`;
}

export function normalizeCoinbaseCdpWalletId(walletAddress: string): string {
  return walletAddress.startsWith("cdp_") ? walletAddress : `cdp_${walletAddress}`;
}

export function normalizeFireblocksWalletId(vaultAccountId: string): string {
  return vaultAccountId.startsWith("fb_") ? vaultAccountId : `fb_${vaultAccountId}`;
}

export function denormalizeFireblocksWalletId(walletId: string): string {
  return walletId.startsWith("fb_") ? walletId.slice("fb_".length) : walletId;
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

export function normalizeUtilaWalletId(walletId: string): string {
  const trimmed = trimUtilaWalletResource(walletId.trim());
  return trimmed.startsWith("utila_") ? trimmed : `utila_${trimmed}`;
}

export function denormalizeUtilaWalletId(walletId: string): string {
  return trimUtilaWalletResource(
    walletId.startsWith("utila_") ? walletId.slice("utila_".length) : walletId
  );
}

function trimUtilaWalletResource(value: string): string {
  const marker = "/wallets/";
  const markerIndex = value.lastIndexOf(marker);
  return markerIndex === -1 ? value : value.slice(markerIndex + marker.length);
}
