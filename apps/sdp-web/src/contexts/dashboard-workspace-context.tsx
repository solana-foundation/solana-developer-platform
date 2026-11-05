"use client";

import { useAuth, useClerk } from "@clerk/nextjs";
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
import {
  clearOrganizationSwitch,
  requestedOrganizationSwitch,
  requestOrganizationSwitch,
} from "@/contexts/requested-organization-switch";
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

type IssuanceWorkspaceTab = "tokens" | "playground";

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
  /** Makes another organization active and lands on its Project (the bare `/dashboard`). */
  switchOrganization: (organizationId: string) => Promise<void>;
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
  const { setActive } = useClerk();
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
      auth.orgId && auth.userId
        ? { orgId: auth.orgId, userId: auth.userId }
        : serverDashboardCacheScope,
    [auth.orgId, auth.userId, serverDashboardCacheScope]
  );
  const liveDashboardCacheScopeKey = useMemo(
    () => getDashboardCacheScopeKey(liveDashboardCacheScope),
    [liveDashboardCacheScope]
  );
  // Set while rendering, before any child reads a key, so a key store never
  // hands one user's or org's Idempotency-Keys to another in the same tab.
  const liveWorkspaceIsMissing = auth.isLoaded && (!auth.userId || !auth.orgId);
  setIdempotencyKeyScope(liveWorkspaceIsMissing ? "" : liveDashboardCacheScopeKey);
  const serverDashboardCacheScopeKey = useMemo(
    () => getDashboardCacheScopeKey(serverDashboardCacheScope),
    [serverDashboardCacheScope]
  );
  const dashboardScopeIsFresh =
    !liveWorkspaceIsMissing && liveDashboardCacheScopeKey === serverDashboardCacheScopeKey;
  const shouldRenderScopeRefreshFallback = !dashboardScopeIsFresh;
  const swrScopeKey = liveWorkspaceIsMissing
    ? "signed-out"
    : `${auth.sessionId}:${getDashboardCacheScopeKey(liveDashboardCacheScope, {
        projectId: selectedProjectId,
      })}`;

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

  const switchOrganization = useCallback(
    async (organizationId: string) => {
      requestOrganizationSwitch(organizationId);
      try {
        await setActive({ organization: organizationId });
      } catch (error) {
        clearOrganizationSwitch();
        throw error;
      }
    },
    [setActive]
  );

  // The organization this tab re-activated to match its URL, so it asks once.
  const alignedOrganizationIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!auth.isLoaded) {
      return;
    }
    if (dashboardScopeIsFresh) {
      // Clerk and the server agree again, on the requested organization or on
      // one Clerk moved to since: a later mismatch is a new one, not this tab's.
      alignedOrganizationIdRef.current = null;
      clearOrganizationSwitch();
      return;
    }
    const requestedOrganizationId = requestedOrganizationSwitch();
    const isOwnSwitch =
      requestedOrganizationId !== null && liveDashboardCacheScope.orgId === requestedOrganizationId;
    if (
      liveWorkspaceIsMissing ||
      isOwnSwitch ||
      liveDashboardCacheScope.userId !== serverDashboardCacheScope.userId
    ) {
      // An Organization switched in this tab, another person signing in, or a
      // session that ended leaves this URL naming a Project they no longer see;
      // the bare landing resolves theirs. A tab without focus may land before
      // Clerk writes the new session cookie, so it lands again until the server
      // renders the requested organization.
      startProjectSwitchTransition(() => {
        router.replace("/dashboard");
      });
      return;
    }
    const serverOrganizationId = serverDashboardCacheScope.orgId;
    if (alignedOrganizationIdRef.current === serverOrganizationId) {
      return;
    }
    // Clerk loaded another organization than the one this URL rendered. Clerk's
    // backend records an organization only when it is made active in a focused
    // tab, so a switch made without focus, or another tab's, comes back on the
    // next load. The URL decides (HOO-2622): Clerk follows the organization it
    // rendered, and Clerk refreshes the page once it is active.
    alignedOrganizationIdRef.current = serverOrganizationId;
    setActive({ organization: serverOrganizationId }).catch((error: unknown) => {
      console.error("Could not make the page's organization active", error);
      startProjectSwitchTransition(() => {
        router.replace("/dashboard");
      });
    });
  }, [
    auth.isLoaded,
    dashboardScopeIsFresh,
    liveWorkspaceIsMissing,
    liveDashboardCacheScope,
    serverDashboardCacheScope,
    router,
    setActive,
  ]);

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
      switchOrganization,
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
      switchOrganization,
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

/**
 * Whether the member may change anything: false for a read-only member, whose
 * page hides every control that writes. Needs the workspace, so a component
 * rendered outside one fails rather than showing writes.
 */
export function useCanWrite(): boolean {
  return useDashboardWorkspace().dashboardAccess.capabilities.canWrite;
}
