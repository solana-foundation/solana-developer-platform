import type * as solanaRpc from "@sdp/rpc/solana";
import type { Address } from "@solana/kit";
import type { z } from "zod";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { createTransferBatchSchema } from "../../schemas";
import type { ResolvedScope } from "../../wallets";

export type CreateTransferBatchInput = z.infer<typeof createTransferBatchSchema>;
export type TransferBatchRecipientInput = CreateTransferBatchInput["recipients"][number];
export type Rpc = solanaRpc.SolanaRpc;
export type RecentBlockhash = Awaited<ReturnType<typeof solanaRpc.getRecentBlockhash>>;

export type TokenContext =
  | {
      kind: "sol";
      token: "SOL";
      decimals: 9;
    }
  | {
      kind: "spl";
      token: string;
      decimals: number;
      mintAddress: Address;
      tokenProgram: Address;
      sourceTokenAccount: Address;
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
