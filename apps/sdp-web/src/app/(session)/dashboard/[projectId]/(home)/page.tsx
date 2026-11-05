import { auth } from "@clerk/nextjs/server";
import { HomeWorkspace } from "@/app/(session)/dashboard/[projectId]/home-workspace";
import { issuance } from "@/flags";
import { isModuleInDeploymentReleaseChannel } from "@/flags/release-channel";

export default async function DashboardPage() {
  const [{ orgId }, issuanceEnabled] = await Promise.all([auth(), issuance()]);
  if (!orgId) {
    return null;
  }
  return (
    <HomeWorkspace
      custodyEnabled={isModuleInDeploymentReleaseChannel("custody")}
      issuanceEnabled={issuanceEnabled}
    />
  );
}
