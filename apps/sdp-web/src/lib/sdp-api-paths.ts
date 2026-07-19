export function getWalletMetadataPath(walletId: string): string {
  return `/v1/wallets/${encodeURIComponent(walletId)}?includeBalance=false`;
}
