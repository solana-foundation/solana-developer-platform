"use client";

import { TOKEN_TRANSACTION_STATUSES, TOKEN_TRANSACTION_TYPES } from "@sdp/types/tokens";
import { z } from "zod";
import type { DashboardRequestKey } from "@/lib/dashboard-request-key";
import { readDashboardRequest } from "@/lib/dashboard-swr";

const tokenTransactionsPageResponseSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      type: z.enum(TOKEN_TRANSACTION_TYPES),
      status: z.enum(TOKEN_TRANSACTION_STATUSES),
      signature: z.string().nullable(),
      createdAt: z.string(),
    })
  ),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});

export interface TokenTransactionsPage {
  transactions: z.infer<typeof tokenTransactionsPageResponseSchema>["data"];
  total: number;
  hasMore: boolean;
}

/** One page of a token's transactions, read from the BFF route the key names. */
export async function readTokenTransactionsPage(
  key: DashboardRequestKey
): Promise<TokenTransactionsPage> {
  const body = await readDashboardRequest(key, tokenTransactionsPageResponseSchema);
  return { transactions: body.data, total: body.total, hasMore: body.hasMore };
}
