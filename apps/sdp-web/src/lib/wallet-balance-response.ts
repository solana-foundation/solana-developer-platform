import { isDecimalString } from "@sdp/solana/amount";
import { z } from "zod";

export const walletTokenBalanceSchema = z.object({
  token: z.string().min(1),
  mint: z.string().min(1),
  amount: z.string().regex(/^\d+$/),
  uiAmount: z
    .string()
    .min(1)
    .refine(isDecimalString)
    .refine((value) => Number.isFinite(Number(value)) && Number(value) >= 0),
  decimals: z.number().int().nonnegative(),
  usdPrice: z.number().optional(),
  usdValue: z.number().optional(),
});

export const walletBalanceResponseSchema = z.object({
  data: z.object({
    walletBalances: z.object({
      custodyWalletId: z.string().min(1),
      walletId: z.string().optional(),
      address: z.string().min(1),
      balances: z.array(walletTokenBalanceSchema),
    }),
  }),
});

export function parseWalletBalanceResponse(body: unknown, custodyWalletId: string) {
  const parsed = walletBalanceResponseSchema.safeParse(body);
  if (!parsed.success || parsed.data.data.walletBalances.custodyWalletId !== custodyWalletId) {
    throw new Error("Wallet balance response did not identify the requested wallet.");
  }
  return parsed.data.data.walletBalances;
}
