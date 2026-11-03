import { z } from "zod";

export const connectionInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  solanaRpcUrl: z.string().trim().url().max(2048),
  indexerUrl: z.string().trim().url().max(2048),
  proverUrl: z.string().trim().url().max(2048),
  ringRpcUrl: z.string().trim().url().max(2048).optional(),
  allowInsecureHttp: z.boolean().default(false),
});
export const connectionParamsSchema = z.strictObject({ connectionId: z.string().trim().min(1) });
