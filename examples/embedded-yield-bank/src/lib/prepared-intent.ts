import { z } from "zod";

/** Signed bytes are a broadcastable authorization, never a private signing key. */
export const preparedIntentSchema = z.strictObject({
  kind: z.enum(["deposit", "withdrawal", "queued", "cancel"]),
  transactionId: z.string().min(1).max(128),
  signedTransaction: z.string().min(1).max(4096),
  idempotencyKey: z.string().min(1).max(128),
});
export type PreparedIntent = z.infer<typeof preparedIntentSchema>;
