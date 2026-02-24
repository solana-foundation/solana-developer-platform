import type { Address } from "@solana/addresses";

export interface DfnsWalletResponse<TAddress extends string = string> {
  id?: string;
  network?: string;
  address?: Address<TAddress> | string;
  signingKey?: { id?: string };
  dateCreated?: string;
  name?: string;
}

export interface DfnsWalletsClient {
  getWallet(request: { walletId: string }): Promise<DfnsWalletResponse>;
}

export interface DfnsSignatureShape {
  r?: string;
  s?: string;
  recid?: number;
  encoded?: string;
}

export type DfnsSignatureStatus =
  | "Pending"
  | "Executing"
  | "Signed"
  | "Confirmed"
  | "Failed"
  | "Rejected";

export type DfnsCreateSignatureBody =
  | {
      kind: "Message";
      message: string;
      blockchainKind?: "Solana";
      network?: string;
      externalId?: string;
    }
  | {
      kind: "Transaction";
      transaction: string;
      blockchainKind?: "Solana";
      network?: string;
      externalId?: string;
    };

export interface DfnsSignatureRequest {
  id?: string;
  keyId?: string;
  status?: DfnsSignatureStatus;
  reason?: string;
  signature?: DfnsSignatureShape;
  signatures?: DfnsSignatureShape[];
  signedData?: string;
  network?: string;
  dateRequested?: string;
  datePolicyResolved?: string;
  dateSigned?: string;
  dateConfirmed?: string;
}

export interface DfnsKeySignaturesClient {
  createSignature(request: {
    keyId: string;
    body: DfnsCreateSignatureBody;
  }): Promise<DfnsSignatureRequest>;
  getSignature(request: { keyId: string; signatureId: string }): Promise<DfnsSignatureRequest>;
}

export interface DfnsApiClient {
  wallets: DfnsWalletsClient;
  keySignatures: DfnsKeySignaturesClient;
}
