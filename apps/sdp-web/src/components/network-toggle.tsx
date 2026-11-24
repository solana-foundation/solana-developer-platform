"use client";

import { SegmentedControl } from "@sdp/ui/segmented-control";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
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
 * Settings for an admin, and tells anyone else that an admin requests it. A deployment that
 * serves one network shows no toggle.
 *
 * @param props.disabled - Holds the toggle while the shell switches organizations.
 */
export function NetworkToggle({ disabled = false }: { disabled?: boolean }) {
  const t = useTranslations();
  const router = useRouter();
  const projectHref = useProjectHref();
  const {
    sandboxProject,
    productionProject,
    sdpEnvironment,
    selectProject,
    isProjectSwitching,
    dashboardAccess,
  } = useDashboardWorkspace();
  const sandboxOnly = useDeploymentSandboxOnly(sandboxProject?.organizationId ?? null);
  if (sandboxProject === null || sandboxOnly) return null;

  const pick = (network: Network) => {
    if (network === "devnet") {
      selectProject(sandboxProject.id);
    } else if (productionProject !== null) {
      selectProject(productionProject.id);
    } else if (dashboardAccess.capabilities.canManageOrgSettings) {
      router.push(projectHref(`${DASHBOARD_SIDE_NAV_HREFS.settings}#mainnet-access`));
    } else {
      // Settings shows the request to admins only, so nobody else is sent there.
      toast.info(t("Shared.SharedComponents.mainnetAccessAdminOnly"));
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
      disabled={disabled || isProjectSwitching}
      className="mt-3"
    />
  );
}
