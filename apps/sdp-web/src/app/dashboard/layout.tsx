import type { Project } from "@sdp/types";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { DashboardShell } from "@/components/dashboard-shell";
import { DashboardWorkspaceProvider } from "@/contexts/dashboard-workspace-context";
import { NetworkDebugProvider } from "@/contexts/network-debug-context";
import { assetProfiles, organizationOnboarding } from "@/flags";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { type DashboardCacheScope, getDashboardCacheScopeKey } from "@/lib/dashboard-cache-scope";
import { resolveDashboardProjectSelection } from "@/lib/dashboard-project-selection";
import type { OrganizationOnboardingStatus } from "@/lib/onboarding-route-guard";
import { PROJECT_COOKIE_NAME } from "@/lib/project-cookie";
import { createOrgSdpApiClient, getSdpAuth, listSdpProjects } from "@/lib/sdp-api";
import type { OnboardingStatusResponse } from "./onboarding-status";

async function loadProjects(): Promise<Project[] | null> {
  try {
    return await listSdpProjects();
  } catch {
    return null;
  }
}

async function loadOnboardingStatus(): Promise<OrganizationOnboardingStatus | null> {
  try {
    const client = await createOrgSdpApiClient();
    const response = await client.fetch<OnboardingStatusResponse>("/v1/onboarding/status");
    return response.setup?.status ?? "not_started";
  } catch (error) {
    console.error("Failed to load onboarding status; leaving dashboard routing unchanged", error);
    return null;
  }
}

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const [{ orgRole, orgId, userId }, onboardingEnabled, assetProfilesEnabled] = await Promise.all([
    getSdpAuth(),
    organizationOnboarding(),
    assetProfiles(),
  ]);

  if (!userId || !orgId) {
    redirect(await getAuthEntryPath());
  }

  const dashboardAccess = resolveDashboardAccess(orgRole);
  const dashboardCacheScope = {
    orgId,
    userId,
  } satisfies DashboardCacheScope;

  const [loadedProjects, onboardingStatus, cookieStore] = await Promise.all([
    loadProjects(),
    onboardingEnabled ? loadOnboardingStatus() : Promise.resolve(null),
    cookies(),
  ]);
  const projects = loadedProjects ?? [];
  const cookieProjectId = cookieStore.get(PROJECT_COOKIE_NAME)?.value ?? null;
  const projectSelection = resolveDashboardProjectSelection(projects, cookieProjectId, {
    projectListIsAuthoritative: loadedProjects !== null,
  });

  return (
    <DashboardWorkspaceProvider
      key={getDashboardCacheScopeKey(dashboardCacheScope)}
      dashboardAccess={dashboardAccess}
      serverDashboardCacheScope={dashboardCacheScope}
      projects={projects}
      initialSelectedProjectId={projectSelection.selectedProjectId}
      shouldRepairInitialProjectCookie={projectSelection.shouldRepairCookie}
    >
      <NetworkDebugProvider>
        <DashboardShell
          assetProfilesEnabled={assetProfilesEnabled}
          onboardingStatus={onboardingStatus}
        >
          {children}
        </DashboardShell>
      </NetworkDebugProvider>
    </DashboardWorkspaceProvider>
  );
}
