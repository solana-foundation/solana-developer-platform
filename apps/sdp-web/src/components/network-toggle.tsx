"use client";

import { SegmentedControl } from "@sdp/ui/segmented-control";
import { useRouter } from "next/navigation";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import { DASHBOARD_SIDE_NAV_HREFS } from "@/lib/dashboard-navigation-loading";
import { useDeploymentSandboxOnly } from "@/lib/deployment-sandbox-only";
import { useProjectHref } from "@/lib/use-dashboard-project";

type Network = "devnet" | "mainnet";

/**
 * The Devnet / Mainnet toggle under the workspace row. One dashboard serves both networks, so a
 * network is the organization's default project for it: Devnet is the sandbox project, which
 * every organization has, and Mainnet the production project. Until the organization's mainnet
 * access is approved the API lists no production project, and Mainnet opens the request in
 * Settings instead. A deployment that serves one network shows no toggle.
 */
export function NetworkToggle() {
  const t = useTranslations();
  const router = useRouter();
  const projectHref = useProjectHref();
  const { sandboxProject, productionProject, sdpEnvironment, selectProject, isProjectSwitching } =
    useDashboardWorkspace();
  const sandboxOnly = useDeploymentSandboxOnly(sandboxProject?.organizationId ?? null);
  if (sandboxProject === null || sandboxOnly) return null;

  const pick = (network: Network) => {
    if (network === "devnet") {
      selectProject(sandboxProject.id);
    } else if (productionProject !== null) {
      selectProject(productionProject.id);
    } else {
      router.push(projectHref(`${DASHBOARD_SIDE_NAV_HREFS.settings}#mainnet-access`));
    }
  };

  return (
    <SegmentedControl
      ariaLabel={t("Shared.SharedComponents.network")}
      options={[
        { value: "devnet", label: t("Shared.SharedComponents.networkDevnet") },
        { value: "mainnet", label: t("Shared.SharedComponents.networkMainnet") },
      ]}
      value={sdpEnvironment === "production" ? "mainnet" : "devnet"}
      onChange={(value) => pick(value === "mainnet" ? "mainnet" : "devnet")}
      disabled={isProjectSwitching}
      className="mt-3"
    />
  );
}
