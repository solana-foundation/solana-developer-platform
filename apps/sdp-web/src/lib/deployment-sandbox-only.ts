import useSWR from "swr";
import { z } from "zod";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import { deploymentQueryKeys } from "@/lib/deployment-query-key";

// Older API revisions omit it; they serve both environments.
const sandboxOnlySchema = z.object({
  data: z.object({ sandboxOnly: z.boolean().default(false) }),
});

async function fetchSandboxOnly(organizationId: string): Promise<boolean> {
  const result = await dashboardFetch<unknown>(
    `/api/dashboard/organizations/${encodeURIComponent(organizationId)}/mainnet-access`
  );
  if (!result.ok) throw new Error(result.error);
  return sandboxOnlySchema.parse(result.data).data.sandboxOnly;
}

/**
 * Whether this deployment serves the sandbox only and takes no mainnet requests, read from the
 * organization's mainnet access the first time a caller asks. It is a fact of the deployment, so
 * it is not re-read on focus; a failed read answers false and is retried on the next mount.
 *
 * @param organizationId - The organization's SDP id, or null to skip the read.
 * @returns True once the API says the deployment is sandbox-only; false until then.
 */
export function useDeploymentSandboxOnly(organizationId: string | null): boolean {
  const { data } = useSWR(
    organizationId === null ? null : deploymentQueryKeys.sandboxOnly({ organizationId }),
    ([, id]) => fetchSandboxOnly(id),
    {
      revalidateOnFocus: false,
      revalidateIfStale: false,
      revalidateOnReconnect: false,
      shouldRetryOnError: false,
    }
  );
  return data === true;
}
