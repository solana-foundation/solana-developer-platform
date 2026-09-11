import type { ListProjectsResponse } from "@sdp/types";
import type { OnboardingStatusResponse } from "@/app/dashboard/onboarding-status";

export type WorkspaceReadiness =
  | { state: "ready"; projectId: string }
  | { state: "pending"; reason: "sync" | "access" | "service" };

export async function resolveWorkspaceReadiness(
  client: { fetch: <T>(path: string, options?: RequestInit) => Promise<T> },
  currentProject: string | null,
  signal?: AbortSignal
): Promise<WorkspaceReadiness> {
  try {
    const status = await client.fetch<OnboardingStatusResponse>("/v1/onboarding/status", {
      signal,
    });
    if (!status.linked) return { state: "pending", reason: "sync" };
    // A linked org alone does not prove the membership and default projects are ready.
    const { projects } = await client.fetch<ListProjectsResponse>("/v1/projects", { signal });
    const project =
      projects.find((item) => item.id === currentProject) ??
      projects.find((item) => item.slug === "default-sandbox") ??
      projects[0];
    return project
      ? { state: "ready", projectId: project.id }
      : { state: "pending", reason: "sync" };
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
