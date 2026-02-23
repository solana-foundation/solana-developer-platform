import type { Address } from "@solana/addresses";
import type {
  Base64EncodedWireTransaction,
  TransactionMessageBytesBase64,
} from "@solana/transactions";

export type ParaWalletType = "EVM" | "SOLANA" | "COSMOS";

export type ParaWalletScheme = "DKLS" | "CGGMP" | "ED25519";

export interface ParaWalletResponse<TAddress extends string = string> {
  id: string;
  type?: ParaWalletType;
  scheme?: ParaWalletScheme;
  status?: "creating" | "ready" | string;
  address?: Address<TAddress> | string;
  publicKey?: string;
}

export interface ParaSignRawRequest {
  data: string;
  walletType: "SOLANA";
}

export interface ParaSignRawResponse {
  signature: string;
}

export interface ParaSignMessageRequest {
  message: TransactionMessageBytesBase64;
}

export interface ParaSignMessageResponse {
  signature: string;
}

export interface ParaSignTransactionRequest {
  transaction: Base64EncodedWireTransaction;
}

export interface ParaSignTransactionResponse {
  signedTransaction: Base64EncodedWireTransaction;
}
