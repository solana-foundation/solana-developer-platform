"use client";

import { useAuth } from "@clerk/nextjs";
import type { Project, SdpEnvironment } from "@sdp/types";
import { usePathname, useRouter } from "next/navigation";
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
import { Button } from "@/components/ui/button";
import type { DashboardAccess } from "@/lib/dashboard-access";
import { type DashboardCacheScope, getDashboardCacheScopeKey } from "@/lib/dashboard-cache-scope";
import { DASHBOARD_SWR_CONFIG } from "@/lib/dashboard-swr-config";
import { useDashboardUrlState } from "@/lib/dashboard-url-state";
import { reconcileProjectCookieAction, selectProjectAction } from "@/lib/project-cookie-action";

export type IssuanceWorkspaceTab = "tokens" | "playground";
export type CounterpartyWorkspaceTab = "overview" | "playground";

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
  projects: Project[];
  sandboxProject: Project | null;
  productionProject: Project | null;
  selectedProjectId: string | null;
  sdpEnvironment: SdpEnvironment;
  isSidebarOpen: boolean;
  issuanceTab: IssuanceWorkspaceTab;
  counterpartyTab: CounterpartyWorkspaceTab;
  playgroundApiKeys: DashboardPlaygroundApiKeyOption[];
  selectedPlaygroundApiKeyId: string | null;
  isProjectSwitching: boolean;
  selectProject: (projectId: string | null) => void;
  setPlaygroundApiKeys: (keys: DashboardPlaygroundApiKeyOption[]) => void;
  setSelectedPlaygroundApiKeyId: (id: string | null) => void;
  setIssuanceTab: (tab: IssuanceWorkspaceTab) => void;
  setCounterpartyTab: (tab: CounterpartyWorkspaceTab) => void;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
};

const DashboardWorkspaceContext = createContext<DashboardWorkspaceContextValue | undefined>(
  undefined
);

function DashboardScopeRefreshFallback() {
  const router = useRouter();

  return (
    <main className="min-h-screen bg-[var(--sdp-shell-bg)] p-0 text-text-extra-high">
      <div className="mx-auto max-w-5xl space-y-4 border border-border-extra-light bg-white/70 p-6">
        <p className="text-sm text-text-low">Loading dashboard...</p>
        <Button type="button" variant="ghost" size="sm" onClick={() => router.refresh()}>
          Retry
        </Button>
      </div>
    </main>
  );
}

type DashboardWorkspaceProviderProps = {
  children: ReactNode;
  dashboardAccess: DashboardAccess;
  serverDashboardCacheScope: DashboardCacheScope;
  projects: Project[];
  initialSelectedProjectId: string | null;
  initialSidebarOpen?: boolean;
};

export function DashboardWorkspaceProvider({
  children,
  dashboardAccess,
  serverDashboardCacheScope,
  projects,
  initialSelectedProjectId,
  initialSidebarOpen = true,
}: DashboardWorkspaceProviderProps) {
  const auth = useAuth();
  const router = useRouter();
  const pathname = usePathname();
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

  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    sandboxProject?.id ?? null
  );
  const sdpEnvironment: SdpEnvironment =
    selectedProjectId && selectedProjectId === productionProject?.id ? "production" : "sandbox";
  const [playgroundApiKeys, setPlaygroundApiKeysState] = useState<
    DashboardPlaygroundApiKeyOption[]
  >([]);
  const [selectedPlaygroundApiKeyId, setSelectedPlaygroundApiKeyId] = useState<string | null>(null);
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
    (projectId: string | null) => {
      startProjectSwitchTransition(async () => {
        await selectProjectAction(projectId);
        setSelectedProjectId(projectId);
        router.replace(pathnameRef.current);
      });
    },
    [router]
  );

  // Persist the in-memory selection to the cookie when:
  //   - the current selection isn't backed by a known project (stale state), or
  //   - the server reported no cookie value at mount (first visit / cleared cookie)
  // Server Components can't write cookies in Next 16, so the layout passes
  // initialSelectedProjectId=null when the cookie is missing/stale; we persist
  // it here via the existing selectProjectAction.
  useEffect(() => {
    const selectionIsValid =
      selectedProjectId !== null && projects.some((project) => project.id === selectedProjectId);
    if (selectionIsValid && initialSelectedProjectId === selectedProjectId) return;

    const target = selectionIsValid ? selectedProjectId : (sandboxProject?.id ?? null);
    if (target !== selectedProjectId) {
      selectProject(target);
    } else if (target !== null) {
      void selectProjectAction(target);
    }
  }, [selectedProjectId, projects, sandboxProject, selectProject, initialSelectedProjectId]);

  useEffect(() => {
    if (!auth.isLoaded || liveDashboardCacheScopeKey === serverDashboardCacheScopeKey) {
      return;
    }

    startProjectSwitchTransition(async () => {
      const ok = await reconcileProjectCookieAction();
      if (!ok) router.refresh();
    });
  }, [auth.isLoaded, liveDashboardCacheScopeKey, serverDashboardCacheScopeKey, router]);

  const previousPathnameRef = useRef(pathname);
  useEffect(() => {
    if (previousPathnameRef.current === pathname) return;
    previousPathnameRef.current = pathname;
    if (searchParams.has("tab")) {
      replaceSearchParams({ tab: null });
    }
  }, [pathname, searchParams, replaceSearchParams]);

  const issuanceTab: IssuanceWorkspaceTab = useMemo(() => {
    const tab = searchParams.get("tab");
    return tab === "playground" ? "playground" : "tokens";
  }, [searchParams]);

  const counterpartyTab: CounterpartyWorkspaceTab = useMemo(() => {
    const tab = searchParams.get("tab");
    return tab === "playground" ? "playground" : "overview";
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

  const setCounterpartyTab = useCallback(
    (tab: CounterpartyWorkspaceTab) => {
      replaceSearchParams({
        tab: tab === "playground" ? "playground" : "overview",
      });
    },
    [replaceSearchParams]
  );

  const value = useMemo<DashboardWorkspaceContextValue>(
    () => ({
      dashboardAccess,
      dashboardCacheScope: liveDashboardCacheScope,
      projects,
      sandboxProject,
      productionProject,
      selectedProjectId,
      sdpEnvironment,
      isSidebarOpen,
      isProjectSwitching,
      issuanceTab,
      counterpartyTab,
      playgroundApiKeys,
      selectedPlaygroundApiKeyId,
      selectProject,
      setPlaygroundApiKeys,
      setSelectedPlaygroundApiKeyId,
      setIssuanceTab,
      setCounterpartyTab,
      setSidebarOpen,
      toggleSidebar,
    }),
    [
      dashboardAccess,
      liveDashboardCacheScope,
      projects,
      sandboxProject,
      productionProject,
      selectedProjectId,
      sdpEnvironment,
      isSidebarOpen,
      isProjectSwitching,
      playgroundApiKeys,
      issuanceTab,
      counterpartyTab,
      selectedPlaygroundApiKeyId,
      selectProject,
      setPlaygroundApiKeys,
      setIssuanceTab,
      setCounterpartyTab,
      setSidebarOpen,
      toggleSidebar,
    ]
  );

  return (
    <DashboardWorkspaceContext.Provider value={value}>
      <SWRConfig key={swrScopeKey} value={scopedSwrConfig}>
        {shouldRenderScopeRefreshFallback ? <DashboardScopeRefreshFallback /> : children}
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
