import type { getRecentBlockhash, SolanaRpc } from "@sdp/rpc/solana";
import type { Address } from "@solana/kit";
import type { z } from "zod";
import type { ResolvedScope } from "@/routes/payments/wallets";
import type { PaymentAmountConverter } from "@/services/payments/token-amount";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { createTransferBatchSchema } from "./schemas";

export type CreateTransferBatchInput = z.infer<typeof createTransferBatchSchema>;
export type TransferBatchRecipientInput = CreateTransferBatchInput["recipients"][number];
export type Rpc = SolanaRpc;
export type RecentBlockhash = Awaited<ReturnType<typeof getRecentBlockhash>>;

export type TokenContext =
  | {
      kind: "sol";
      /** Canonical native token value: the wrapped SOL mint. */
      token: string;
      decimals: 9;
      toBaseUnits: PaymentAmountConverter;
    }
  | {
      kind: "spl";
      token: string;
      decimals: number;
      mintAddress: Address;
      tokenProgram: Address;
      sourceTokenAccount: Address;
      /** Loaded once per batch; every recipient amount converts through it. */
      toBaseUnits: PaymentAmountConverter;
    };

export interface ResolvedRecipient {
  index: number;
  externalId: string | null;
  counterpartyId: string;
  counterpartyAccountId: string;
  destinationAddress: Address;
  amount: string;
  amountBaseUnits: bigint;
}

export interface ResolvedBatchRequest {
  scope: ResolvedScope;
  projectId: string;
  sourceWallet: CustodyWallet;
  sourceAddress: Address;
  tokenContext: TokenContext;
  recipients: ResolvedRecipient[];
  totalAmount: string;
  rpc: Rpc;
}
