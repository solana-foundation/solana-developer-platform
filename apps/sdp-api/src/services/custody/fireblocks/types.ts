/**
 * Fireblocks Types
 *
 * Minimal response shapes used by the Fireblocks provider.
 */

export interface FireblocksSignedMessage {
  content?: string;
  signature?: unknown;
  publicKey?: string;
}

export interface FireblocksTransaction {
  id: string;
  status: string;
  subStatus?: string;
  signedMessages?: FireblocksSignedMessage[];
}

export interface FireblocksAddress {
  address: string;
  publicKey?: string;
  addressId?: string;
}

export interface FireblocksProviderConfig {
  apiKey: string;
  apiSecretPem: string;
  vaultAccountId: string;
  assetId: string;
  defaultWalletId?: string;
  apiBaseUrl?: string;
}
