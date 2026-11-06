import { isAddress } from "@solana/addresses";
import { z } from "zod";

const id = z.string().trim().min(1).max(255);
const wallet = z.string().trim().refine(isAddress, "Invalid Solana address");
export const custodyPreparationSchema = z.object({ strategyId: id, custodyWalletId: id }).strict();
export const externalPreparationSchema = z
  .object({ strategyId: id, ownerAddress: wallet, feePayer: wallet.optional() })
  .strict();
export const custodyCancellationSchema = z.object({ movementId: id }).strict();
export const externalCancellationSchema = z
  .object({ movementId: id, feePayer: wallet.optional() })
  .strict();
export const providerActionSubmitSchema = z
  .object({ actionId: id, signedTransaction: z.string().min(1).max(4096) })
  .strict();
export const providerActionParamsSchema = z.object({ actionId: id });
