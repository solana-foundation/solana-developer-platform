import { z } from "zod";

export const walletBalancesQuerySchema = z.object({
  minimumSlot: z
    .string()
    .regex(/^(0|[1-9]\d*)$/)
    .transform(Number)
    .pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER))
    .optional(),
});

export const walletIdParamsSchema = z.object({
  walletId: z.string().min(1),
});
