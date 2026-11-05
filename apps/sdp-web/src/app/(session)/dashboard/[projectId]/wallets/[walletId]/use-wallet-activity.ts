"use client";

import type { SWRConfiguration } from "swr";
import { z } from "zod";
import { custodyQueryKeys } from "@/app/(session)/dashboard/[projectId]/wallets/custody-query-key";
import {
  WALLET_ACTIVITY_LIMIT,
  type WalletActivityPayload,
} from "@/app/(session)/dashboard/[projectId]/wallets/wallet-activity.data";
import {
  type DashboardReadError,
  useDashboardKeyScope,
  useDashboardRead,
} from "@/lib/dashboard-swr";

const walletActivityRowSchema = z.object({
  id: z.string(),
  sourceKind: z.enum(["payments", "issuance"]),
  operationLabel: z.string(),
  status: z.string(),
  signature: z.string().nullable(),
  token: z.string().optional(),
  amount: z.string().optional(),
  address: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

const walletActivityResponseSchema = z.object({
  data: z.object({
    activityRows: z.array(walletActivityRowSchema),
    activityError: z.string().nullable(),
    activityNotice: z.string().nullable(),
    hasMore: z.boolean().optional(),
  }),
});

type WalletActivityResponse = z.infer<typeof walletActivityResponseSchema>;

/**
 * The wallet's latest `limit` activity rows (payments and issuance, newest first), read again
 * every 20s while the page is open. The default window is shared by the Overview's recent rows
 * and the Activity tab, so switching tabs reads the same cache; each wider window the Activity
 * tab asks for has a key of its own (see `useWalletActivityWindow`). `onSuccess` and `onError`
 * fire only when a read this hook started settles, never for rows that were already cached.
 */
export function useWalletActivity(
  walletId: string,
  limit: number = WALLET_ACTIVITY_LIMIT,
  callbacks?: {
    onSuccess?: (data: WalletActivityPayload) => void;
    onError?: (error: DashboardReadError) => void;
  }
) {
  const scope = useDashboardKeyScope();
  const onSuccess = callbacks?.onSuccess;
  const onError = callbacks?.onError;
  const config: SWRConfiguration<WalletActivityResponse, DashboardReadError> = {
    refreshInterval: 20_000,
    refreshWhenHidden: false,
    onSuccess: onSuccess === undefined ? undefined : (response) => onSuccess(response.data),
    onError,
  };
  const response = useDashboardRead(
    custodyQueryKeys.walletActivity(scope, { walletId, limit }),
    walletActivityResponseSchema,
    config
  );
  return { ...response, data: response.data?.data };
}
