"use client";

import { useAuth } from "@clerk/nextjs";
import useSWR from "swr";
import { readOrganizationsLinked } from "@/app/dashboard/organization-link-actions";
import { organizationQueryKeys } from "@/lib/organization-query-key";

const NO_ORGANIZATIONS: ReadonlySet<string> = new Set();

/** The Clerk organizations this deployment does not link, and whether that is known yet. */
export interface UnlinkedOrganizations {
  unlinkedIds: ReadonlySet<string>;
  isResolved: boolean;
}

async function readUnlinkedOrganizations(
  organizationIds: readonly string[],
  getToken: ReturnType<typeof useAuth>["getToken"]
): Promise<ReadonlySet<string>> {
  const tokens = await Promise.all(
    organizationIds.map(async (organizationId) => {
      const token = await getToken({ organizationId });
      if (!token) {
        throw new Error("Failed to acquire Clerk token");
      }
      return token;
    })
  );
  const linked = await readOrganizationsLinked(tokens);
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
