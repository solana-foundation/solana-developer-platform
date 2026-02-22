import type { Address } from "@solana/addresses";
import type {
  Base64EncodedWireTransaction,
  TransactionMessageBytesBase64,
} from "@solana/transactions";

export interface WalletResponse<TAddress extends string = string> {
  address: Address<TAddress>;
  name?: string;
}

export interface SignMessageRequest {
  message: TransactionMessageBytesBase64;
}

export interface SignMessageResponse {
  signature: string;
}

export interface SignTransactionRequest {
  transaction: Base64EncodedWireTransaction;
}

export interface SignTransactionResponse {
  signedTransaction: Base64EncodedWireTransaction;
}
