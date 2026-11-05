"use client";

import { EARN_PROVIDERS } from "@sdp/types/provider-access";
import { z } from "zod";
import { useDashboardKeyScope, useDashboardRead } from "@/lib/dashboard-swr";
import { earnQueryKeys } from "./earn-query-key";
import type { EarnProviderAccess } from "./earn-surfacing";

const earnProviderAccessResponseSchema = z.object({
  data: z.object({
    providerAccess: z
      .partialRecord(
        z.enum(EARN_PROVIDERS),
        z.object({ entitled: z.boolean(), configured: z.boolean(), enabled: z.boolean() })
      )
      .nullable(),
  }),
});

/**
 * The organization's Earn entitlement and configuration, read from the server: a catalogue row
 * says a strategy exists, never that this organization may fund it. `undefined` until the first
 * answer lands; `null` (access could not be verified) and a failed read both disable deposits.
 */
export function useEarnProviderAccess(): {
  providerAccess: EarnProviderAccess | null | undefined;
} {
  const scope = useDashboardKeyScope();
  const { data, error } = useDashboardRead(
    earnQueryKeys.providerAccess(scope),
    earnProviderAccessResponseSchema
  );
  if (data !== undefined) return { providerAccess: data.data.providerAccess };
  return { providerAccess: error === undefined ? undefined : null };
}
