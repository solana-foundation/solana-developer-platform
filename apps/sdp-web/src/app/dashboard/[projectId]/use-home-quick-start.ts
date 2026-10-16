"use client";

import { useSyncExternalStore } from "react";
import { useOptionalDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import {
  isQuickStartDismissed,
  quickStartKey,
  readQuickStart,
  subscribeQuickStart,
} from "@/lib/dashboard-quick-start";

/** Keep Home's loading and settled layouts in sync with local dismissal. */
export function useHomeQuickStartPending(): boolean {
  const workspace = useOptionalDashboardWorkspace();
  const key = workspace ? quickStartKey(workspace.dashboardCacheScope) : null;
  const initialStep = workspace?.initialQuickStartStep;
  const finished = useSyncExternalStore(
    subscribeQuickStart,
    () =>
      key !== null && (isQuickStartDismissed(key) || readQuickStart(key, initialStep) === "done"),
    () => initialStep === "done"
  );

  return Boolean(
    workspace?.sdpEnvironment === "sandbox" &&
      workspace.dashboardAccess.capabilities.canManageApiKeys &&
      initialStep === "api-key" &&
      !finished
  );
}
