"use client";

import { useAuth } from "@clerk/nextjs";
import useSWR from "swr";
import { z } from "zod";
import { dashboardRequest } from "@/lib/dashboard-fetch";
import { organizationQueryKeys } from "@/lib/organization-query-key";

const NO_ORGANIZATIONS: ReadonlySet<string> = new Set();

/** The Clerk organizations this deployment does not link, and whether that is known yet. */
export interface UnlinkedOrganizations {
  unlinkedIds: ReadonlySet<string>;
  isResolved: boolean;
}

export const ORGANIZATION_LINKED_PATH = "/api/dashboard/organizations/linked";

const organizationLinkedSchema = z.object({ linked: z.boolean() });

async function readOrganizationLinked(
  organizationId: string,
  getToken: ReturnType<typeof useAuth>["getToken"]
): Promise<boolean> {
  const token = await getToken({ organizationId });
  if (!token) {
    throw new Error("Failed to acquire Clerk token");
  }
  const response = await dashboardRequest(ORGANIZATION_LINKED_PATH, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`Organization link read failed (${response.status})`);
  }
  return organizationLinkedSchema.parse(await response.json()).linked;
}

async function readUnlinkedOrganizations(
  organizationIds: readonly string[],
  getToken: ReturnType<typeof useAuth>["getToken"]
): Promise<ReadonlySet<string>> {
  const linked = await Promise.all(
    organizationIds.map((organizationId) => readOrganizationLinked(organizationId, getToken))
  );
  return new Set(organizationIds.filter((_, index) => !linked[index]));
}

/**
 * The person's Clerk organizations this deployment does not link. Prod, stage and
 * beta share one Clerk instance, so a person's Clerk organizations include ones
 * another deployment created, which SDP here answers `linked: false` for (ADR 0012).
 * Only that answer hides an organization. A failed read resolves with none hidden:
 * hiding is a convenience, and SDP still refuses an organization it does not know.
 *
 * @param organizationIds - The Clerk organizations to ask about.
 * @returns The ones to hide, and whether every answer is in.
 */
export function useUnlinkedOrganizations(
  organizationIds: readonly string[]
): UnlinkedOrganizations {
  const { getToken, userId } = useAuth();
  const ids = [...new Set(organizationIds)].sort();
  const { data, error } = useSWR(
    userId && ids.length > 0
      ? organizationQueryKeys.unlinkedOrganizations({ userId, organizationIds: ids })
      : null,
    () => readUnlinkedOrganizations(ids, getToken),
    // Loading another page of organizations keeps the answers already in, so the
    // list does not fall back to loading while the new page is asked about.
    {
      keepPreviousData: true,
      revalidateOnFocus: false,
      revalidateIfStale: false,
      shouldRetryOnError: false,
    }
  );
  return {
    unlinkedIds: data ?? NO_ORGANIZATIONS,
    isResolved: !userId || ids.length === 0 || data !== undefined || error !== undefined,
  };
}
