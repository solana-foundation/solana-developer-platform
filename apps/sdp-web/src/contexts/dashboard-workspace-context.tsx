"use client";

import { type ReactNode, createContext, useCallback, useContext, useMemo, useState } from "react";

export type IssuanceWorkspaceTab = "tokens" | "playground";

export interface DashboardIssuanceApiKeyOption {
  id: string;
  name: string;
  keyPrefix: string;
  role: string;
  environment: string;
}

type DashboardWorkspaceContextValue = {
  isSidebarOpen: boolean;
  selectedProject: string;
  issuanceTab: IssuanceWorkspaceTab;
  issuanceApiKeys: DashboardIssuanceApiKeyOption[];
  selectedIssuanceApiKeyId: string | null;
  setIssuanceApiKeys: (keys: DashboardIssuanceApiKeyOption[]) => void;
  setSelectedIssuanceApiKeyId: (id: string | null) => void;
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
  defaultProject?: string;
  initialSidebarOpen?: boolean;
};

export function DashboardWorkspaceProvider({
  children,
  defaultProject = "Default Project",
  initialSidebarOpen = true,
}: DashboardWorkspaceProviderProps) {
  const [isSidebarOpen, setSidebarOpenState] = useState(initialSidebarOpen);
  const [selectedProject, setSelectedProject] = useState(defaultProject);
  const [issuanceTab, setIssuanceTab] = useState<IssuanceWorkspaceTab>("tokens");
  const [issuanceApiKeys, setIssuanceApiKeysState] = useState<DashboardIssuanceApiKeyOption[]>([]);
  const [selectedIssuanceApiKeyId, setSelectedIssuanceApiKeyId] = useState<string | null>(null);

  const setSidebarOpen = useCallback((open: boolean) => {
    setSidebarOpenState(open);
  }, []);

  const setIssuanceApiKeys = useCallback((keys: DashboardIssuanceApiKeyOption[]) => {
    setIssuanceApiKeysState(keys);
    setSelectedIssuanceApiKeyId((current) => {
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

  const value = useMemo<DashboardWorkspaceContextValue>(
    () => ({
      isSidebarOpen,
      selectedProject,
      issuanceTab,
      issuanceApiKeys,
      selectedIssuanceApiKeyId,
      setIssuanceApiKeys,
      setSelectedIssuanceApiKeyId,
      setSelectedProject,
      setIssuanceTab,
      setSidebarOpen,
      toggleSidebar,
    }),
    [
      isSidebarOpen,
      issuanceApiKeys,
      issuanceTab,
      selectedIssuanceApiKeyId,
      selectedProject,
      setIssuanceApiKeys,
      setSidebarOpen,
      toggleSidebar,
    ]
  );

  return (
    <DashboardWorkspaceContext.Provider value={value}>
      {children}
    </DashboardWorkspaceContext.Provider>
  );
}

export function useDashboardWorkspace() {
  const context = useContext(DashboardWorkspaceContext);

  if (!context) {
    // biome-ignore lint/nursery/noSecrets: This is a React hook guard message, not a secret.
    throw new Error("useDashboardWorkspace must be used within a DashboardWorkspaceProvider");
  }

  return context;
}
