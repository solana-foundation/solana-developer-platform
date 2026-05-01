import { auth } from "@clerk/nextjs/server";
import type { OrganizationRpcProvider } from "@sdp/types";
import { redirect } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { fetchProviderAvailability } from "@/lib/provider-availability";
import { createTimedTrace } from "@/lib/request-tracing";
import { createSdpApiClient } from "@/lib/sdp-api";
import { OrganizationRpcSettingsForm } from "./organization-rpc-settings-form";

type OrganizationSettings = {
  rpcProvider?: OrganizationRpcProvider;
};

type Organization = {
  id: string;
  name: string;
  settings: OrganizationSettings | null;
};

type OnboardingStatusResponse = {
  linked: boolean;
  organization: Organization | null;
};

type ProjectListResponse = {
  projects: Array<{
    id: string;
    organizationId: string;
  }>;
};

export default async function SettingsPage() {
  const { userId, orgId, orgRole } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }

  const trace = createTimedTrace("dashboard.settings.page");
  const dashboardAccess = resolveDashboardAccess(orgRole);

  let organization: Organization | null = null;
  let isLinked = true;
  let loadError = false;
  let enabledRpcProviders: OrganizationRpcProvider[] = [];

  try {
    const apiClient = await trace.step("create_sdp_api_client", () =>
      createSdpApiClient(trace.childContext("dashboard.settings.api"))
    );
    let onboardingFailed = false;

    try {
      const onboarding = await trace.step("fetch_onboarding_status", () =>
        apiClient.fetch<OnboardingStatusResponse>("/v1/onboarding/status")
      );
      isLinked = onboarding.linked;
      organization = onboarding.organization;
    } catch {
      onboardingFailed = true;
    }

    if (!organization && isLinked) {
      try {
        const projectsPayload = await trace.step("fetch_projects", () =>
          apiClient.fetch<ProjectListResponse>("/v1/projects")
        );
        const inferredOrgId = projectsPayload.projects[0]?.organizationId;
        if (inferredOrgId) {
          organization = await trace.step("fetch_inferred_organization", () =>
            apiClient.fetch<Organization>(`/v1/organizations/${inferredOrgId}`)
          );
        }
      } catch {}
    }

    if (!organization && isLinked && orgId) {
      try {
        organization = await trace.step("fetch_org_by_active_org_id", () =>
          apiClient.fetch<Organization>(`/v1/organizations/${orgId}`)
        );
      } catch {}
    }

    if (!organization && isLinked && onboardingFailed) {
      loadError = true;
    }

    if (organization) {
      const resolvedOrganization = organization;
      try {
        const access = await trace.step("fetch_provider_access", () =>
          fetchProviderAvailability(apiClient.request, resolvedOrganization.id)
        );
        enabledRpcProviders = access.enabledRpcProviders;
      } catch {
        enabledRpcProviders = ["default"];
      }
    }

    trace.log({
      ok: !loadError,
      isLinked,
      hasOrganization: Boolean(organization),
      enabledRpcProviderCount: enabledRpcProviders.length,
      loadError,
    });
  } catch (error) {
    loadError = true;
    trace.log({
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }

  return (
    <div className="w-full flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Organization settings</CardTitle>
          <CardDescription>
            Configure the RPC provider used across this organization.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="w-full space-y-6">
            {loadError ? (
              <div className="rounded-xl border border-[rgba(158,43,56,0.2)] bg-[rgba(158,43,56,0.06)] px-3 py-2 text-sm text-[#9e2b38]">
                Failed to load organization settings.
              </div>
            ) : null}

            {!loadError && !organization && isLinked ? (
              <div className="rounded-xl border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.04)] px-3 py-2 text-sm text-[rgba(28,28,29,0.68)]">
                Organization not found.
              </div>
            ) : null}

            {!loadError && organization ? (
              <OrganizationRpcSettingsForm
                organization={organization}
                canManageSettings={dashboardAccess.capabilities.canManageOrgSettings}
                enabledProviders={enabledRpcProviders}
              />
            ) : null}

            {!loadError && !organization && !isLinked ? (
              <div className="rounded-xl border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.04)] px-3 py-2 text-sm text-[rgba(28,28,29,0.68)]">
                This Clerk organization is not linked to an SDP organization yet.
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
