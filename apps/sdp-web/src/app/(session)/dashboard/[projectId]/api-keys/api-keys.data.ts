"use client";

import { type Action, isAction } from "@sdp/types/actions";
import { API_KEY_STATUSES, API_KEY_WALLET_SCOPES, SDP_ENVIRONMENTS } from "@sdp/types/api-keys";
import { z } from "zod";
import { useApiKey } from "@/app/(session)/dashboard/[projectId]/payments/shared-reads";
import { useDashboardKeyScope, useDashboardRead } from "@/lib/dashboard-swr";
import type { ApiKeyAuthoringExistingKey } from "./api-key-authoring";
import { apiKeysQueryKeys } from "./api-keys-query-key";
import type { ApiKeyRecord } from "./api-keys-table-client";

const actionSchema = z.string().refine((value): value is Action => isAction(value));

const apiKeyRecordSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  keyPrefix: z.string(),
  grants: z.array(actionSchema),
  environment: z.enum(SDP_ENVIRONMENTS),
  status: z.enum(API_KEY_STATUSES),
  walletScope: z.enum(API_KEY_WALLET_SCOPES),
  walletIds: z.array(z.string()),
  lastUsedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  rotationDeadline: z.string().nullable(),
  createdAt: z.string(),
}) satisfies z.ZodType<ApiKeyRecord>;

const apiKeyListResponseSchema = z.object({
  data: z.object({ apiKeys: z.array(apiKeyRecordSchema) }),
});

export function useApiKeys() {
  const scope = useDashboardKeyScope();
  const response = useDashboardRead(apiKeysQueryKeys.list(scope), apiKeyListResponseSchema);
  return { ...response, data: response.data?.data.apiKeys };
}

export function useApiKeyForAuthoring(keyId: string) {
  const response = useApiKey(keyId, { keepPreviousData: false });
  const apiKey: ApiKeyAuthoringExistingKey | undefined = response.data;
  return { ...response, data: apiKey };
}
