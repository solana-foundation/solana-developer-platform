"use client";

import type { TokenAllowlistEntry } from "@sdp/types/tokens";
import { z } from "zod";
import type { DashboardRequestKey } from "@/lib/dashboard-request-key";
import { readDashboardRequest } from "@/lib/dashboard-swr";

export interface TokenAllowlistPage {
  entries: TokenAllowlistEntry[];
  total: number;
  hasMore: boolean;
  page: number;
  pageSize: number;
}

const tokenAllowlistEntrySchema = z.object({
  id: z.string(),
  tokenId: z.string(),
  address: z.string(),
  label: z.string().nullable(),
  status: z.enum(["pending", "active", "revoked"]),
  addedBy: z.string(),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
}) satisfies z.ZodType<TokenAllowlistEntry>;

const tokenAllowlistPageResponseSchema = z.object({
  data: z.array(tokenAllowlistEntrySchema),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});

/** One page of a token's access list, read from the BFF route the key names. */
export async function readTokenAllowlistPage(
  key: DashboardRequestKey
): Promise<TokenAllowlistPage> {
  const body = await readDashboardRequest(key, tokenAllowlistPageResponseSchema);
  return {
    entries: body.data,
    total: body.total,
    hasMore: body.hasMore,
    page: body.page,
    pageSize: body.pageSize,
  };
}

export const tokenAllowlistLabelsResponseSchema = z.object({
  labels: z.array(z.string()),
  // Total active control-list entries (unfiltered) — drives the summary count,
  // since the paged list's total reflects the active search/label filter.
  total: z.number().int().nonnegative(),
});
