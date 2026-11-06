import { IntegrationsSkeleton } from "@/app/(session)/dashboard/[projectId]/integrations/integrations-skeleton";
import { integrationsSkeletonSections } from "@/app/(session)/dashboard/[projectId]/integrations/integrations-skeleton-sections";
import {
  deploymentReleaseChannel,
  isModuleInDeploymentReleaseChannel,
} from "@/flags/release-channel";

/**
 * The hard-navigation path. Awaiting the Vercel flags here would hold the skeleton back,
 * so it follows the release channel alone, which is a plain env read; flags inside the
 * channel can only hide a family it draws.
 */
export default function IntegrationsLoading() {
  const sections = integrationsSkeletonSections({
    releaseChannel: deploymentReleaseChannel(),
    custody: isModuleInDeploymentReleaseChannel("custody"),
    ramps: isModuleInDeploymentReleaseChannel("ramps"),
    compliance: isModuleInDeploymentReleaseChannel("compliance"),
    privateChannels: isModuleInDeploymentReleaseChannel("private_channels"),
  });
  return (
    <div className="contents" data-loading-layout="integrations">
      <IntegrationsSkeleton sections={sections} />
    </div>
  );
}
