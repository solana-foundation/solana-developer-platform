"use client";

import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

type DashboardWorkspaceContextValue = {
  isSidebarOpen: boolean;
  selectedProject: string;
  setSelectedProject: (project: string) => void;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
};

const DashboardWorkspaceContext = createContext<DashboardWorkspaceContextValue | undefined>(undefined);

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

  const setSidebarOpen = useCallback((open: boolean) => {
    setSidebarOpenState(open);
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarOpenState((current) => !current);
  }, []);

  const value = useMemo<DashboardWorkspaceContextValue>(
    () => ({
      isSidebarOpen,
      selectedProject,
      setSelectedProject,
      setSidebarOpen,
      toggleSidebar,
    }),
    [isSidebarOpen, selectedProject, setSidebarOpen, toggleSidebar],
  );

  return <DashboardWorkspaceContext.Provider value={value}>{children}</DashboardWorkspaceContext.Provider>;
}

export function useDashboardWorkspace() {
  const context = useContext(DashboardWorkspaceContext);

  if (!context) {
    throw new Error("useDashboardWorkspace must be used within a DashboardWorkspaceProvider");
  }

  return context;
}
