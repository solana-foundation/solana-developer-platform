import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { resolvePlaygroundApiBaseUrl } from "@/app/(session)/dashboard/[projectId]/playground-api-data";
import {
  dashboardWorkspaceOverviewPanelClassName,
  dashboardWorkspacePlaygroundPanelClassName,
} from "@/components/dashboard-workspace-panel";
import { DashboardWorkspaceTabShell } from "@/components/dashboard-workspace-tab-shell";
import { issuance } from "@/flags";
import { getEnabledRampProviders, isRampsEnabled } from "@/flags/ramps";
import { isModuleInDeploymentReleaseChannel } from "@/flags/release-channel";
import { PaymentsCommandCenter } from "./payments-command-center";
import { PaymentsPlaygroundWorkspace } from "./payments-workspace";

export default async function PaymentsPage() {
  const { orgId } = await auth();
  if (!orgId) {
    redirect("/dashboard");
  }

  const [rampsOffered, issuanceEnabled, rampProviders] = await Promise.all([
    isRampsEnabled(),
    issuance(),
    // The quote endpoints offer the providers the channel-capped flags leave on, never the raw list.
    getEnabledRampProviders(),
  ]);

  return (
    <DashboardWorkspaceTabShell
      panels={[
        {
          id: "overview",
          className: dashboardWorkspaceOverviewPanelClassName,
          content: (
            <PaymentsCommandCenter
              modules={{
                rampsOffered,
                rampsInReleaseChannel: isModuleInDeploymentReleaseChannel("ramps"),
                complianceInReleaseChannel: isModuleInDeploymentReleaseChannel("compliance"),
                issuanceEnabled,
                enabledRampProviders: rampProviders,
              }}
            />
          ),
        },
        {
          id: "playground",
          className: dashboardWorkspacePlaygroundPanelClassName,
          content: (
            <PaymentsPlaygroundWorkspace
              apiBaseUrl={resolvePlaygroundApiBaseUrl()}
              rampProviders={rampProviders}
            />
          ),
        },
      ]}
    />
  );
}
