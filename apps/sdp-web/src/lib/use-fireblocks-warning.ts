"use client";

import { useCallback, useSyncExternalStore } from "react";
import { useOptionalDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { getDashboardCacheScopeKey } from "@/lib/dashboard-cache-scope";
import { useProjectId } from "@/lib/use-dashboard-project";

const CHANGE = "sdp:fireblocks-warning-dismissed";
function subscribe(onChange: () => void) {
  window.addEventListener(CHANGE, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGE, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** No expiry; preferences belong to this user, organization and project on this browser. */
export function useFireblocksWarning(kind: "whitelist" | "policy") {
  const workspace = useOptionalDashboardWorkspace();
  const projectId = useProjectId();
  const key =
    workspace && projectId
      ? `sdp:fireblocks-warning:v1:${getDashboardCacheScopeKey(workspace.dashboardCacheScope, { projectId })}:${kind}`
      : null;
  const suppressed = useSyncExternalStore(
    subscribe,
    () => {
      try {
        return key !== null && window.localStorage.getItem(key) === "dismissed";
      } catch {
        return false;
      }
    },
    () => false
  );
  const suppress = useCallback((): boolean => {
    if (!key) return false;
    try {
      window.localStorage.setItem(key, "dismissed");
      window.dispatchEvent(new Event(CHANGE));
      return true;
    } catch {
      return false;
    }
  }, [key]);
  return { suppressed, suppress, canSuppress: key !== null, scopeKey: key };
}
