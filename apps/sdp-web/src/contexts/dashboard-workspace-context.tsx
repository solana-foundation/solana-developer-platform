"use client";

import { useAuth } from "@clerk/nextjs";
import type { SdpEnvironment } from "@sdp/types";
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
} from "react";
import { SWRConfig } from "swr";
import { Button } from "@/components/ui/button";
import type { DashboardAccess } from "@/lib/dashboard-access";
import { type DashboardCacheScope, getDashboardCacheScopeKey } from "@/lib/dashboard-cache-scope";
import { DASHBOARD_SWR_CONFIG } from "@/lib/dashboard-swr-config";
import { useDashboardUrlState } from "@/lib/dashboard-url-state";

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
  sdpEnvironment: SdpEnvironment;
  isSidebarOpen: boolean;
  selectedProject: string;
  issuanceTab: IssuanceWorkspaceTab;
  counterpartyTab: CounterpartyWorkspaceTab;
  playgroundApiKeys: DashboardPlaygroundApiKeyOption[];
  selectedPlaygroundApiKeyId: string | null;
  setSdpEnvironment: (value: SdpEnvironment) => void;
  setPlaygroundApiKeys: (keys: DashboardPlaygroundApiKeyOption[]) => void;
  setSelectedPlaygroundApiKeyId: (id: string | null) => void;
  setSelectedProject: (project: string) => void;
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

const DASHBOARD_SCOPED_SWR_CONFIG = {
  ...DASHBOARD_SWR_CONFIG,
  provider: () => new Map(),
};

type DashboardWorkspaceProviderProps = {
  children: ReactNode;
  dashboardAccess: DashboardAccess;
  serverDashboardCacheScope: DashboardCacheScope;
  defaultProject?: string;
  initialSidebarOpen?: boolean;
};

export function DashboardWorkspaceProvider({
  children,
  dashboardAccess,
  serverDashboardCacheScope,
  defaultProject = "Default Project",
  initialSidebarOpen = true,
}: DashboardWorkspaceProviderProps) {
  const auth = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const { replaceSearchParams, searchParams } = useDashboardUrlState();
  const [isSidebarOpen, setSidebarOpenState] = useState(initialSidebarOpen);
  const [sdpEnvironment, setSdpEnvironment] = useState<SdpEnvironment>("sandbox");
  const [selectedProject, setSelectedProject] = useState(defaultProject);
  const [playgroundApiKeys, setPlaygroundApiKeysState] = useState<
    DashboardPlaygroundApiKeyOption[]
  >([]);
  const [selectedPlaygroundApiKeyId, setSelectedPlaygroundApiKeyId] = useState<string | null>(null);
  const liveDashboardCacheScope = useMemo<DashboardCacheScope>(
    () =>
      auth.isLoaded
        ? {
            orgId: auth.orgId ?? null,
            userId: auth.userId ?? null,
          }
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
    environment: sdpEnvironment,
  });

  useEffect(() => {
    if (!auth.isLoaded || liveDashboardCacheScopeKey === serverDashboardCacheScopeKey) {
      return;
    }

    router.refresh();
  }, [auth.isLoaded, liveDashboardCacheScopeKey, router, serverDashboardCacheScopeKey]);

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
      sdpEnvironment,
      isSidebarOpen,
      selectedProject,
      issuanceTab,
      counterpartyTab,
      playgroundApiKeys,
      selectedPlaygroundApiKeyId,
      setSdpEnvironment,
      setPlaygroundApiKeys,
      setSelectedPlaygroundApiKeyId,
      setSelectedProject,
      setIssuanceTab,
      setCounterpartyTab,
      setSidebarOpen,
      toggleSidebar,
    }),
    [
      dashboardAccess,
      liveDashboardCacheScope,
      sdpEnvironment,
      isSidebarOpen,
      playgroundApiKeys,
      issuanceTab,
      counterpartyTab,
      selectedPlaygroundApiKeyId,
      selectedProject,
      setPlaygroundApiKeys,
      setIssuanceTab,
      setCounterpartyTab,
      setSidebarOpen,
      toggleSidebar,
    ]
  );

  return (
    <DashboardWorkspaceContext.Provider value={value}>
      <SWRConfig key={swrScopeKey} value={DASHBOARD_SCOPED_SWR_CONFIG}>
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
