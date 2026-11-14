import { z } from "zod";
import { fireblocksRegistrationSchema } from "@/services/custody/byok-credential";

export const createFireblocksCsrSchema = z.object({}).strict();
export const discoverFireblocksVaultsSchema = fireblocksRegistrationSchema
  .omit({ vaultAccountId: true })
  .extend({
    after: z.string().min(1).max(512).optional(),
    namePrefix: z.string().trim().max(100).optional(),
  })
  .strict();
