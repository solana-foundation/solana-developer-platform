import { z } from "zod";

export const listFireblocksProposalsSchema = z.object({
  walletId: z.string().min(1).max(128),
  kind: z.enum(["signing", "transfer"]),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
export const cancelFireblocksProposalParams = z.object({
  kind: z.enum(["signing", "transfer"]),
  proposalId: z.string().min(1).max(128),
});
