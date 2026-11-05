"use client";

import { useOrganizationProviderAccess } from "@/app/(session)/dashboard/[projectId]/payments/shared-reads";
import type { EarnProviderAccess } from "./earn-surfacing";

/**
 * The organization's Earn entitlement and configuration, read from the server: a catalogue row
 * says a strategy exists, never that this organization may fund it. `undefined` until the first
 * answer lands; a failed read is no access (`null`), which disables every deposit action.
 */
export function useEarnProviderAccess(): {
  providerAccess: EarnProviderAccess | null | undefined;
} {
  const { data, error } = useOrganizationProviderAccess();
  if (data !== undefined) return { providerAccess: data.earn };
  return { providerAccess: error === undefined ? undefined : null };
}
