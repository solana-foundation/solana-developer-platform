"use client";

import {
  ASSET_AUDIT_ACTOR_TYPES,
  ASSET_AUDIT_STATUSES,
  type AssetAuditEvent,
} from "@sdp/types/audit";
import { z } from "zod";
import type { DashboardRequestKey } from "@/lib/dashboard-request-key";
import { readDashboardRequest } from "@/lib/dashboard-swr";

export interface AssetAuditHistory {
  events: AssetAuditEvent[];
  total: number;
  hasMore: boolean;
}

const assetAuditEventSchema = z.object({
  id: z.string(),
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string().nullable(),
  actorType: z.enum(ASSET_AUDIT_ACTOR_TYPES),
  actorLabel: z.string(),
  status: z.enum(ASSET_AUDIT_STATUSES),
  createdAt: z.string(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
}) satisfies z.ZodType<AssetAuditEvent>;

const assetAuditHistoryResponseSchema = z.object({
  data: z.array(assetAuditEventSchema),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});

/** One window of a token's audit history, read from the BFF route the key names. */
export async function readAssetAuditHistory(key: DashboardRequestKey): Promise<AssetAuditHistory> {
  const body = await readDashboardRequest(key, assetAuditHistoryResponseSchema);
  return { events: body.data, total: body.total, hasMore: body.hasMore };
}
