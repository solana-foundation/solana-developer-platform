"use client";

import { ASSET_CATEGORIES } from "@sdp/types/asset-profiles";
import { z } from "zod";
import type { DashboardRequestKey } from "@/lib/dashboard-request-key";
import { readDashboardRequest } from "@/lib/dashboard-swr";
import type { IssuanceTokenListItem } from "./issuance-tokens.data";

export interface IssuanceTokensClientPage {
  tokens: IssuanceTokenListItem[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

const issuanceListTokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  symbol: z.string(),
  status: z.string(),
  template: z.string(),
  imageUrl: z.string().nullable(),
  mintAddress: z.string().nullable(),
  totalSupply: z.string(),
  createdAt: z.string(),
  deployedAt: z.string().nullable(),
  decimals: z.number(),
  maxSupply: z.string().nullable(),
  isMintable: z.boolean(),
  isFreezable: z.boolean(),
  requiresAllowlist: z.boolean(),
  description: z.string().nullable(),
  uri: z.string().nullable(),
  signingCustodyWalletId: z.string().nullable(),
  mintAuthority: z.string().nullable(),
  metadataAuthority: z.string().nullable(),
  freezeAuthority: z.string().nullable(),
  permanentDelegate: z.string().nullable(),
  assetProfile: z
    .object({
      assetCategory: z.enum(ASSET_CATEGORIES),
      assetType: z.string(),
      assetTypeVersion: z.number(),
      issuanceMetadata: z.record(z.string(), z.unknown()),
    })
    .nullable(),
}) satisfies z.ZodType<IssuanceTokenListItem>;

const issuanceTokenListResponseSchema = z.object({
  data: z.array(issuanceListTokenSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  hasMore: z.boolean(),
});

/** One page of the asset list, read from the BFF route the key names. */
export async function readIssuanceTokensPage(
  key: DashboardRequestKey
): Promise<IssuanceTokensClientPage> {
  const body = await readDashboardRequest(key, issuanceTokenListResponseSchema);
  return {
    tokens: body.data,
    total: body.total,
    page: body.page,
    pageSize: body.pageSize,
    hasMore: body.hasMore,
  };
}
