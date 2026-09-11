import { getSelectedProjectId, listSdpProjects } from "./sdp-api";

/**
 * Resolve the selected project without touching a chain-backed endpoint.
 *
 * The dashboard layout already reads this project list through request-scoped
 * caching. Markets pages use the same read to avoid starting live Devnet work
 * before their client boundary can see `DashboardWorkspaceContext`.
 * Unknown state fails closed to the live path; it must never turn a possibly
 * production project into a browser-local sandbox.
 */
export async function isSelectedProjectSandbox(): Promise<boolean> {
  try {
    const [projects, selectedProjectId] = await Promise.all([
      listSdpProjects(),
      getSelectedProjectId(),
    ]);
    const productionProject = projects.find((project) => project.slug === "default-production");
    // Keep this predicate identical to DashboardWorkspaceProvider: anything
    // other than the positively selected production project is the sandbox.
    return !(selectedProjectId && selectedProjectId === productionProject?.id);
  } catch {
    return false;
  }
}
