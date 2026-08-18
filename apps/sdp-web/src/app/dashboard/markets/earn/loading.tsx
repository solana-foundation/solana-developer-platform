import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { EarnOverviewSkeleton } from "./earn-route-skeletons";

export default function EarnLoading() {
  return (
    <DashboardWorkspaceOverviewPanel>
      <EarnOverviewSkeleton />
    </DashboardWorkspaceOverviewPanel>
  );
}
