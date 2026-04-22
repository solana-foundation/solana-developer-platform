"use client";

import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { SWRConfig } from "swr";
import type { DashboardAccess } from "@/lib/dashboard-access";
import { DASHBOARD_SWR_CONFIG } from "@/lib/dashboard-swr-config";
import { useDashboardUrlState } from "@/lib/dashboard-url-state";

export type IssuanceWorkspaceTab = "tokens" | "playground";

export interface DashboardCacheScope {
  userId: string | null;
  orgId: string | null;
}

export interface DashboardPlaygroundApiKeyOption {
  id: string;
  name: string;
  keyPrefix: string;
  role: string;
  environment: string;
}

type DashboardWorkspaceContextValue = {
  dashboardAccess: DashboardAccess;
  dashboardCacheScope: DashboardCacheScope;
  isSidebarOpen: boolean;
  selectedProject: string;
  issuanceTab: IssuanceWorkspaceTab;
  playgroundApiKeys: DashboardPlaygroundApiKeyOption[];
  selectedPlaygroundApiKeyId: string | null;
  setPlaygroundApiKeys: (keys: DashboardPlaygroundApiKeyOption[]) => void;
  setSelectedPlaygroundApiKeyId: (id: string | null) => void;
  setSelectedProject: (project: string) => void;
  setIssuanceTab: (tab: IssuanceWorkspaceTab) => void;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
};

const DashboardWorkspaceContext = createContext<DashboardWorkspaceContextValue | undefined>(
  undefined
);

type DashboardWorkspaceProviderProps = {
  children: ReactNode;
  dashboardAccess: DashboardAccess;
  dashboardCacheScope: DashboardCacheScope;
  defaultProject?: string;
  initialSidebarOpen?: boolean;
};

export function DashboardWorkspaceProvider({
  children,
  dashboardAccess,
  dashboardCacheScope,
  defaultProject = "Default Project",
  initialSidebarOpen = true,
}: DashboardWorkspaceProviderProps) {
  const { replaceSearchParams, searchParams } = useDashboardUrlState();
  const [isSidebarOpen, setSidebarOpenState] = useState(initialSidebarOpen);
  const [selectedProject, setSelectedProject] = useState(defaultProject);
  const [playgroundApiKeys, setPlaygroundApiKeysState] = useState<
    DashboardPlaygroundApiKeyOption[]
  >([]);
  const [selectedPlaygroundApiKeyId, setSelectedPlaygroundApiKeyId] = useState<string | null>(null);

  const issuanceTab: IssuanceWorkspaceTab = useMemo(() => {
    const tab = searchParams.get("tab");
    return tab === "playground" ? "playground" : "tokens";
  }, [searchParams]);

  const setSidebarOpen = useCallback((open: boolean) => {
    setSidebarOpenState(open);
  }, []);

  const setPlaygroundApiKeys = useCallback((keys: DashboardPlaygroundApiKeyOption[]) => {
    setPlaygroundApiKeysState(keys);
    setSelectedPlaygroundApiKeyId((current) => {
      if (keys.length === 0) {
        return null;
      }
      if (current && keys.some((key) => key.id === current)) {
        return current;
      }
      return keys[0].id;
    });
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarOpenState((current) => !current);
  }, []);

  const setIssuanceTab = useCallback(
    (tab: IssuanceWorkspaceTab) => {
      replaceSearchParams({
        tab: tab === "playground" ? "playground" : "overview",
      });
    },
    [replaceSearchParams]
  );

  const value = useMemo<DashboardWorkspaceContextValue>(
    () => ({
      dashboardAccess,
      dashboardCacheScope,
      isSidebarOpen,
      selectedProject,
      issuanceTab,
      playgroundApiKeys,
      selectedPlaygroundApiKeyId,
      setPlaygroundApiKeys,
      setSelectedPlaygroundApiKeyId,
      setSelectedProject,
      setIssuanceTab,
      setSidebarOpen,
      toggleSidebar,
    }),
    [
      dashboardAccess,
      dashboardCacheScope,
      isSidebarOpen,
      playgroundApiKeys,
      issuanceTab,
      selectedPlaygroundApiKeyId,
      selectedProject,
      setPlaygroundApiKeys,
      setIssuanceTab,
      setSidebarOpen,
      toggleSidebar,
    ]
  );

  return (
    <DashboardWorkspaceContext.Provider value={value}>
      <SWRConfig value={DASHBOARD_SWR_CONFIG}>{children}</SWRConfig>
    </DashboardWorkspaceContext.Provider>
  );
}

export function useDashboardWorkspace() {
  const context = useContext(DashboardWorkspaceContext);

  if (!context) {
    // biome-ignore lint/security/noSecrets: This is a React hook guard message, not a secret.
    throw new Error("useDashboardWorkspace must be used within a DashboardWorkspaceProvider");
  }

  return context;
}
