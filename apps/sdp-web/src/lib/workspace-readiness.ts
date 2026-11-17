import type { ListProjectsResponse } from "@sdp/types/projects";
import type { OnboardingStatusResponse } from "@/app/(session)/dashboard/[projectId]/onboarding-status";
import { resolveProjectFromList } from "./dashboard-project-selection";
import { resolveMainnetOnlyLanding } from "./mainnet-only-landing";

export type WorkspaceReadiness =
  | { state: "ready"; projectId: string }
  /** The deployment serves mainnet only and SDP has not turned mainnet on for the organization. */
  | { state: "locked" }
  | { state: "pending"; reason: "sync" | "access" | "service" };

export async function resolveWorkspaceReadiness(
  client: { fetch: <T>(path: string, options?: RequestInit) => Promise<T> },
  signal?: AbortSignal
): Promise<WorkspaceReadiness> {
  try {
    const status = await client.fetch<OnboardingStatusResponse>("/v1/onboarding/status", {
      signal,
    });
    if (!status.linked) return { state: "pending", reason: "sync" };
    // A linked org alone does not prove the membership and default projects are ready.
    const { projects } = await client.fetch<ListProjectsResponse>("/v1/projects", { signal });
    const project = resolveProjectFromList(projects, null);
    if (project) return { state: "ready", projectId: project.id };
    // A deployment that serves mainnet only lists no sandbox to wait for.
    const mainnetOnly = status.organization
      ? await resolveMainnetOnlyLanding(client, status.organization.id, projects, null, signal)
      : null;
    if (mainnetOnly?.kind === "project")
      return { state: "ready", projectId: mainnetOnly.project.id };
    if (mainnetOnly?.kind === "locked") return { state: "locked" };
    return { state: "pending", reason: "sync" };
  } catch (error) {
    const status = error && typeof error === "object" && "status" in error ? error.status : null;
    const reason =
      status === 401 || status === 403
        ? "access"
        : status === 404 || status === 409 || status === 425
          ? "sync"
          : "service";
    return { state: "pending", reason };
  }
}
