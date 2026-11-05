"use client";

import { EARN_PROVIDERS } from "@sdp/types/provider-access";
import { z } from "zod";
import { useDashboardKeyScope, useDashboardRead } from "@/lib/dashboard-swr";
import { earnQueryKeys } from "./earn-query-key";
import type { EarnProviderAccess } from "./earn-surfacing";

const earnProviderAccessResponseSchema = z.object({
  data: z.object({
    providers: z.object({
      earn: z.partialRecord(
        z.enum(EARN_PROVIDERS),
        z.object({ entitled: z.boolean(), configured: z.boolean(), enabled: z.boolean() })
      ),
    }),
  }),
});

/**
 * The organization's Earn entitlement and configuration, read from the server: a catalogue row
 * says a strategy exists, never that this organization may fund it. `undefined` until the first
 * answer lands; a failed read is no access (`null`), which disables every deposit action.
 */
export function useEarnProviderAccess(): {
  providerAccess: EarnProviderAccess | null | undefined;
} {
  const scope = useDashboardKeyScope();
  const { data, error } = useDashboardRead(
    earnQueryKeys.providerAccess(scope),
    earnProviderAccessResponseSchema
  );
  if (data !== undefined) return { providerAccess: data.data.providers.earn };
  return { providerAccess: error === undefined ? undefined : null };
}
