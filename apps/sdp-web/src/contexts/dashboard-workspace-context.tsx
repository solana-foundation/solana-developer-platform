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
import { useTranslations } from "@/i18n/provider";
import type { DashboardAccess } from "@/lib/dashboard-access";
import { type DashboardCacheScope, getDashboardCacheScopeKey } from "@/lib/dashboard-cache-scope";
import { DASHBOARD_SWR_CONFIG } from "@/lib/dashboard-swr-config";
import { useDashboardUrlState } from "@/lib/dashboard-url-state";
import { reconcileProjectCookieAction, selectProjectAction } from "@/lib/project-cookie-action";
import { shouldClearDashboardTabAfterPathnameChange } from "./dashboard-workspace-url-state";

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
  const t = useTranslations();

  return (
    <main className="min-h-screen bg-[var(--sdp-shell-bg)] p-0 text-primary">
      <div className="mx-auto max-w-5xl space-y-4 border border-border-subtle bg-surface-raised/70 p-6">
        <p className="text-sm text-tertiary">{t("Shared.dashboardShell.loadingDashboard")}</p>
        <Button type="button" variant="ghost" size="sm" onClick={() => router.refresh()}>
          {t("Shared.SharedComponents.retry")}
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
  shouldRepairInitialProjectCookie: boolean;
  initialSidebarOpen?: boolean;
};

export function DashboardWorkspaceProvider({
  children,
  dashboardAccess,
  serverDashboardCacheScope,
  projects,
  initialSelectedProjectId,
  shouldRepairInitialProjectCookie,
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
    // Read the tab straight from the URL, not the useSyncExternalStore snapshot:
    // App Router <Link> navigation fires no popstate/custom event, so the snapshot
    // can still hold the previous page's tab. Acting on that stale value would wipe
    // an explicit deep-link destination (e.g. ?tab=playground) that just committed.
    const tab =
      typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("tab");
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
