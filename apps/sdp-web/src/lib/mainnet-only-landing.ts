import { MAINNET_ACCESS_STATES } from "@sdp/types/mainnet-access";
import type { Project } from "@sdp/types/projects";
import { z } from "zod";

/** Where an organization waits on a deployment that serves mainnet only until SDP turns mainnet on. */
export const MAINNET_ACCESS_PATH = "/mainnet-access";

const DEFAULT_PRODUCTION_PROJECT_SLUG = "default-production";

const mainnetOnlyAccessSchema = z.object({
  state: z.enum(MAINNET_ACCESS_STATES),
  // Older API revisions omit it; they serve both environments.
  mainnetOnly: z.boolean().default(false),
});

type ProjectLike = Pick<Project, "id" | "slug">;

export type MainnetOnlyLanding<TProject extends ProjectLike> =
  | { kind: "project"; project: TProject }
  | { kind: "locked" }
  | { kind: "provisioning" };

/**
 * Where an organization that lists no sandbox lands on a deployment that serves mainnet only:
 * its last-used or default production project once SDP has turned mainnet on, else the mainnet
 * request page. Elsewhere the dashboard keeps landing on the sandbox, so this answers null and the
 * caller waits for the sandbox as before.
 *
 * @param client - An organization-scoped sdp-api client.
 * @param organizationId - The organization's SDP id.
 * @param projects - The organization's listed projects.
 * @param lastUsedProjectId - The last-used hint from the selection cookie.
 * @returns The landing, or null when the deployment also serves the sandbox.
 */
export async function resolveMainnetOnlyLanding<TProject extends ProjectLike>(
  client: { fetch: <T>(path: string, options?: RequestInit) => Promise<T> },
  organizationId: string,
  projects: readonly TProject[],
  lastUsedProjectId: string | null | undefined,
  signal?: AbortSignal
): Promise<MainnetOnlyLanding<TProject> | null> {
  const access = mainnetOnlyAccessSchema.parse(
    await client.fetch<unknown>(
      `/v1/organizations/${encodeURIComponent(organizationId)}/mainnet-access`,
      { signal }
    )
  );
  if (!access.mainnetOnly) return null;
  if (access.state !== "approved") return { kind: "locked" };
  const project =
    projects.find((candidate) => candidate.id === lastUsedProjectId) ??
    projects.find((candidate) => candidate.slug === DEFAULT_PRODUCTION_PROJECT_SLUG);
  return project === undefined ? { kind: "provisioning" } : { kind: "project", project };
}
