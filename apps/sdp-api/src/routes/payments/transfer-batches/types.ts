import type { getRecentBlockhash, SolanaRpc } from "@sdp/rpc/solana";
import type { Address } from "@solana/kit";
import type { z } from "zod";
import type { ResolvedScope } from "@/routes/payments/wallets";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { PlannedLeg, PlannedTokenMovement } from "@/services/token-movement/build";
import type { createTransferBatchSchema } from "./schemas";

export type CreateTransferBatchInput = z.infer<typeof createTransferBatchSchema>;
export type TransferBatchRecipientInput = CreateTransferBatchInput["recipients"][number];
export type Rpc = SolanaRpc;
export type RecentBlockhash = Awaited<ReturnType<typeof getRecentBlockhash>>;

export interface ResolvedRecipient {
  index: number;
  externalId: string | null;
  counterpartyId: string;
  counterpartyAccountId: string;
  destinationAddress: Address;
  /** The recipient's quote and the accounts its transfer moves between. */
  leg: PlannedLeg;
}

export interface ResolvedBatchRequest {
  scope: ResolvedScope;
  projectId: string;
  sourceWallet: CustodyWallet;
  sourceAddress: Address;
  /** The token as batch and transfer rows store it: a mint, native SOL as the wrapped SOL mint. */
  token: string;
  /** The batch's one terms read, its source and every recipient's leg. */
  plan: PlannedTokenMovement;
  recipients: ResolvedRecipient[];
  rpc: Rpc;
}
