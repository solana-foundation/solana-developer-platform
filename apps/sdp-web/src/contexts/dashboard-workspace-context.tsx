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
import {
  DEFAULT_ISSUANCE_TOKEN_VIEW,
  persistIssuanceTokenView,
  type TokenView,
} from "@/app/dashboard/issuance/issuance-token-view";
import { FullscreenLoadingIndicator } from "@/components/fullscreen-loading-indicator";
import type { DashboardAccess } from "@/lib/dashboard-access";
import { type DashboardCacheScope, getDashboardCacheScopeKey } from "@/lib/dashboard-cache-scope";
import { DASHBOARD_SWR_CONFIG } from "@/lib/dashboard-swr-config";
import { readDashboardTabFromUrl, useDashboardUrlState } from "@/lib/dashboard-url-state";
import { reconcileProjectCookieAction, selectProjectAction } from "@/lib/project-cookie-action";
import { shouldClearDashboardTabAfterPathnameChange } from "./dashboard-workspace-url-state";

export type IssuanceWorkspaceTab = "tokens" | "playground";

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
  /** Grid ⇄ list preference for the issuance overview; see issuance-token-view.ts. */
  issuanceTokenView: TokenView;
  playgroundApiKeys: DashboardPlaygroundApiKeyOption[];
  selectedPlaygroundApiKeyId: string | null;
  isProjectSwitching: boolean;
  selectProject: (projectId: string | null) => void;
  setPlaygroundApiKeys: (keys: DashboardPlaygroundApiKeyOption[]) => void;
  setSelectedPlaygroundApiKeyId: (id: string | null) => void;
  setIssuanceTokenView: (view: TokenView) => void;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
};

const DashboardWorkspaceContext = createContext<DashboardWorkspaceContextValue | undefined>(
  undefined
);

type DashboardWorkspaceProviderProps = {
  children: ReactNode;
  dashboardAccess: DashboardAccess;
  serverDashboardCacheScope: DashboardCacheScope;
  projects: Project[];
  initialSelectedProjectId: string | null;
  shouldRepairInitialProjectCookie: boolean;
  initialSidebarOpen?: boolean;
  /** Read from the view cookie by the dashboard layout, so SSR paints it. */
  initialIssuanceTokenView?: TokenView;
};

export function DashboardWorkspaceProvider({
  children,
  dashboardAccess,
  serverDashboardCacheScope,
  projects,
  initialSelectedProjectId,
  shouldRepairInitialProjectCookie,
  initialSidebarOpen = true,
  initialIssuanceTokenView = DEFAULT_ISSUANCE_TOKEN_VIEW,
}: DashboardWorkspaceProviderProps) {
  const auth = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const { replaceSearchParams, searchParams } = useDashboardUrlState();
  const [isSidebarOpen, setSidebarOpenState] = useState(initialSidebarOpen);
  const [issuanceTokenView, setIssuanceTokenViewState] =
    useState<TokenView>(initialIssuanceTokenView);
  const sandboxProject = useMemo(
    () => projects.find((project) => project.slug === "default-sandbox") ?? null,
    [projects]
  );
  const productionProject = useMemo(
    () => projects.find((project) => project.slug === "default-production") ?? null,
    [projects]
  );

  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    initialSelectedProjectId
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

  const initialCookieRepairStarted = useRef(false);
  useEffect(() => {
    if (!shouldRepairInitialProjectCookie || initialCookieRepairStarted.current) return;

    initialCookieRepairStarted.current = true;
    void selectProjectAction(initialSelectedProjectId).catch(() => {
      initialCookieRepairStarted.current = false;
    });
  }, [initialSelectedProjectId, shouldRepairInitialProjectCookie]);

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
    const previousPathname = previousPathnameRef.current;
    if (previousPathname === pathname) return;
    previousPathnameRef.current = pathname;
    // The snapshot can still hold the previous page's tab here; acting on that stale
    // value would wipe an explicit deep-link destination (e.g. ?tab=playground).
    const tab = readDashboardTabFromUrl();
    if (
      shouldClearDashboardTabAfterPathnameChange({
        previousPathname,
        pathname,
        tab,
      })
    ) {
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

  // Mirrored into the cookie so the next server render — page and loading
  // skeleton alike — starts in the view the user just chose.
  const setIssuanceTokenView = useCallback((view: TokenView) => {
    setIssuanceTokenViewState(view);
    persistIssuanceTokenView(view);
  }, []);

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
      issuanceTokenView,
      playgroundApiKeys,
      selectedPlaygroundApiKeyId,
      selectProject,
      setPlaygroundApiKeys,
      setSelectedPlaygroundApiKeyId,
      setIssuanceTokenView,
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
      issuanceTokenView,
      selectedPlaygroundApiKeyId,
      selectProject,
      setPlaygroundApiKeys,
      setIssuanceTokenView,
      setSidebarOpen,
      toggleSidebar,
    ]
  );

  return (
    <DashboardWorkspaceContext.Provider value={value}>
      <SWRConfig key={swrScopeKey} value={scopedSwrConfig}>
        {shouldRenderScopeRefreshFallback ? (
          <FullscreenLoadingIndicator allowDelayedReload />
        ) : (
          children
        )}
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

// Deliberately tolerant of a missing provider, unlike useDashboardWorkspace: the
// issuance loading skeletons read the view, and a Suspense fallback is also
// mounted standalone by the route-loading unit tests. Falling back to the default
// view there beats making every one of those call sites stand up a provider.
export function useIssuanceTokenView(): TokenView {
  return useContext(DashboardWorkspaceContext)?.issuanceTokenView ?? DEFAULT_ISSUANCE_TOKEN_VIEW;
}
