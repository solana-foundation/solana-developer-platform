"use client";

import { useAuth } from "@clerk/nextjs";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import type { Project } from "@sdp/types/projects";
import { useRouter } from "next/navigation";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { SWRConfig } from "swr";
import type { DashboardFlags } from "@/flags/dashboard";
import type { DashboardAccess } from "@/lib/dashboard-access";
import { type DashboardCacheScope, getDashboardCacheScopeKey } from "@/lib/dashboard-cache-scope";
import { projectSwitchDestination } from "@/lib/dashboard-navigation-loading";
import { projectHref } from "@/lib/dashboard-project-path";
import { DASHBOARD_SWR_CONFIG } from "@/lib/dashboard-swr-config";
import { readDashboardTabFromUrl, useDashboardUrlState } from "@/lib/dashboard-url-state";
import { setIdempotencyKeyScope } from "@/lib/idempotency-key-store";
import { useDashboardPathname, useProjectId } from "@/lib/use-dashboard-project";
import { shouldClearDashboardTabAfterPathnameChange } from "./dashboard-workspace-url-state";

export type IssuanceWorkspaceTab = "tokens" | "playground";

type DashboardWorkspaceContextValue = {
  initialQuickStartStatus: import("@/lib/dashboard-quick-start").QuickStartStatus | null;
  dashboardAccess: DashboardAccess;
  flags: DashboardFlags;
  dashboardCacheScope: DashboardCacheScope;
  projects: Project[];
  sandboxProject: Project | null;
  productionProject: Project | null;
  selectedProjectId: string;
  sdpEnvironment: SdpEnvironment;
  isSidebarOpen: boolean;
  issuanceTab: IssuanceWorkspaceTab;
  isProjectSwitching: boolean;
  selectProject: (projectId: string) => void;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
};

const DashboardWorkspaceContext = createContext<DashboardWorkspaceContextValue | undefined>(
  undefined
);

type DashboardWorkspaceProviderProps = {
  initialQuickStartStatus?: import("@/lib/dashboard-quick-start").QuickStartStatus | null;
  children: ReactNode;
  scopeRefreshFallback: ReactNode;
  dashboardAccess: DashboardAccess;
  flags: DashboardFlags;
  serverDashboardCacheScope: DashboardCacheScope;
  projects: Project[];
  initialSidebarOpen?: boolean;
};

export function DashboardWorkspaceProvider({
  initialQuickStartStatus = null,
  children,
  scopeRefreshFallback,
  dashboardAccess,
  flags,
  serverDashboardCacheScope,
  projects,
  initialSidebarOpen = true,
}: DashboardWorkspaceProviderProps) {
  const auth = useAuth();
  const router = useRouter();
  const pathname = useDashboardPathname();
  const { replaceSearchParams, searchParams } = useDashboardUrlState();
  const [isSidebarOpen, setSidebarOpenState] = useState(initialSidebarOpen);
  const sandboxProject = useMemo(
    () => projects.find((project) => project.slug === "default-sandbox") ?? null,
    [projects]
  );
  const productionProject = useMemo(
    () => projects.find((project) => project.slug === "default-production") ?? null,
    [projects]
  );

  const selectedProjectId = useProjectId();
  const sdpEnvironment: SdpEnvironment =
    selectedProjectId === productionProject?.id ? "production" : "sandbox";
  const liveDashboardCacheScope = useMemo<DashboardCacheScope>(
    () =>
      auth.isLoaded && auth.orgId && auth.userId
        ? { orgId: auth.orgId, userId: auth.userId }
        : serverDashboardCacheScope,
    [auth.isLoaded, auth.orgId, auth.userId, serverDashboardCacheScope]
  );
  const liveDashboardCacheScopeKey = useMemo(
    () => getDashboardCacheScopeKey(liveDashboardCacheScope),
    [liveDashboardCacheScope]
  );
  // Set while rendering, before any child reads a key, so a key store never
  // hands one user's or org's Idempotency-Keys to another in the same tab.
  setIdempotencyKeyScope(liveDashboardCacheScopeKey);
  const serverDashboardCacheScopeKey = useMemo(
    () => getDashboardCacheScopeKey(serverDashboardCacheScope),
    [serverDashboardCacheScope]
  );
  const dashboardScopeIsFresh = liveDashboardCacheScopeKey === serverDashboardCacheScopeKey;
  const shouldRenderScopeRefreshFallback = auth.isLoaded && !dashboardScopeIsFresh;
  const swrScopeKey = getDashboardCacheScopeKey(liveDashboardCacheScope, {
    projectId: selectedProjectId,
  });

  const [isProjectSwitching, startProjectSwitchTransition] = useTransition();

  const isProjectSwitchingRef = useRef(false);
  isProjectSwitchingRef.current = isProjectSwitching;

  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;

  const scopedSwrConfig = useMemo(
    () => ({
      ...DASHBOARD_SWR_CONFIG,
      provider: () => new Map(),
      isPaused: () => isProjectSwitchingRef.current,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const selectProject = useCallback(
    (projectId: string) => {
      startProjectSwitchTransition(() => {
        router.push(projectHref(projectId, projectSwitchDestination(pathnameRef.current)));
      });
    },
    [router]
  );

  // An Organization switched in Clerk leaves this URL naming the previous
  // Organization's Project; the bare landing resolves the new one's.
  useEffect(() => {
    if (!auth.isLoaded || liveDashboardCacheScopeKey === serverDashboardCacheScopeKey) {
      return;
    }

    startProjectSwitchTransition(() => {
      router.replace("/dashboard");
    });
  }, [auth.isLoaded, liveDashboardCacheScopeKey, serverDashboardCacheScopeKey, router]);

  const previousPathnameRef = useRef(pathname);
  useEffect(() => {
    const previousPathname = previousPathnameRef.current;
    if (previousPathname === pathname) return;
    previousPathnameRef.current = pathname;
    // The snapshot can still hold the previous page's tab here; acting on that stale
    // value would wipe an explicit deep-link destination (e.g. ?tab=playground).
    const tab = readDashboardTabFromUrl();
    if (shouldClearDashboardTabAfterPathnameChange({ previousPathname, pathname, tab })) {
      replaceSearchParams({ tab: null });
    }
  }, [pathname, replaceSearchParams]);

  const issuanceTab: IssuanceWorkspaceTab = useMemo(() => {
    const tab = searchParams.get("tab");
    return tab === "playground" ? "playground" : "tokens";
  }, [searchParams]);

  const setSidebarOpen = useCallback((open: boolean) => {
    setSidebarOpenState(open);
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarOpenState((current) => !current);
  }, []);

  const value = useMemo<DashboardWorkspaceContextValue>(
    () => ({
      initialQuickStartStatus: dashboardScopeIsFresh ? initialQuickStartStatus : null,
      dashboardAccess,
      flags,
      dashboardCacheScope: liveDashboardCacheScope,
      projects,
      sandboxProject,
      productionProject,
      selectedProjectId,
      sdpEnvironment,
      isSidebarOpen,
      isProjectSwitching,
      issuanceTab,
      selectProject,
      setSidebarOpen,
      toggleSidebar,
    }),
    [
      initialQuickStartStatus,
      dashboardScopeIsFresh,
      dashboardAccess,
      flags,
      liveDashboardCacheScope,
      projects,
      sandboxProject,
      productionProject,
      selectedProjectId,
      sdpEnvironment,
      isSidebarOpen,
      isProjectSwitching,
      issuanceTab,
      selectProject,
      setSidebarOpen,
      toggleSidebar,
    ]
  );

  return (
    <DashboardWorkspaceContext.Provider value={value}>
      <SWRConfig key={swrScopeKey} value={scopedSwrConfig}>
        {shouldRenderScopeRefreshFallback ? scopeRefreshFallback : children}
      </SWRConfig>
    </DashboardWorkspaceContext.Provider>
  );
}

export function useDashboardWorkspace() {
  const context = useContext(DashboardWorkspaceContext);

  if (!context) {
    throw new Error("useDashboardWorkspace must be used within a DashboardWorkspaceProvider");
  }

  return context;
}

export function useOptionalDashboardWorkspace() {
  return useContext(DashboardWorkspaceContext);
}
