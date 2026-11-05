"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import useSWR, { type BareFetcher, type Key, type SWRConfiguration, type SWRResponse } from "swr";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { getDashboardCacheScopeKey } from "@/lib/dashboard-cache-scope";
import { DASHBOARD_CACHE_STORAGE_PREFIX } from "@/lib/dashboard-snapshot-storage";

export interface PersistedDashboardSnapshotConfig<Data> {
  key: string;
  ttlMs: number;
  version?: number;
  storage?: "local" | "session";
  shouldPersist?: (value: Data) => boolean;
}

interface PersistedDashboardSnapshotEnvelope<Data> {
  expiresAt: number;
  value: Data;
  version: number;
}

const DEFAULT_PERSISTED_SNAPSHOT_VERSION = 1;

function subscribeToStorage(onChange: () => void) {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

const readNoStoredSnapshot = () => null;

function getStorage(storage: "local" | "session" = "local"): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return storage === "session" ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
}

function buildScopedSnapshotKey(scopeKey: string, key: string): string {
  return `${DASHBOARD_CACHE_STORAGE_PREFIX}.${scopeKey}.${key}`;
}

function readStoredSnapshot<Data>(
  scopeKey: string,
  config: PersistedDashboardSnapshotConfig<Data> | undefined
): string | null {
  const storage = config ? getStorage(config.storage) : null;
  if (!config || !storage) {
    return null;
  }

  try {
    return storage.getItem(buildScopedSnapshotKey(scopeKey, config.key));
  } catch {
    // A blocked read only costs the instant paint; fresh data still loads.
    return null;
  }
}

function parsePersistedDashboardSnapshot<Data>(
  rawValue: string | null,
  scopeKey: string,
  config: PersistedDashboardSnapshotConfig<Data>
): Data | undefined {
  const storage = getStorage(config.storage);
  if (!rawValue || !storage) {
    return undefined;
  }

  const storageKey = buildScopedSnapshotKey(scopeKey, config.key);
  try {
    const envelope = JSON.parse(rawValue) as PersistedDashboardSnapshotEnvelope<Data>;
    const version = config.version ?? DEFAULT_PERSISTED_SNAPSHOT_VERSION;

    if (typeof envelope.expiresAt !== "number" || envelope.expiresAt <= Date.now()) {
      storage.removeItem(storageKey);
      return undefined;
    }

    if (envelope.version !== version) {
      storage.removeItem(storageKey);
      return undefined;
    }

    return envelope.value;
  } catch {
    // Storage reads and eviction can both be blocked. Fresh data still loads.
    return undefined;
  }
}

function writePersistedDashboardSnapshot<Data>(
  scopeKey: string,
  config: PersistedDashboardSnapshotConfig<Data>,
  value: Data
) {
  const storage = getStorage(config.storage);
  if (!storage) {
    return;
  }

  const storageKey = buildScopedSnapshotKey(scopeKey, config.key);
  const envelope: PersistedDashboardSnapshotEnvelope<Data> = {
    expiresAt: Date.now() + config.ttlMs,
    value,
    version: config.version ?? DEFAULT_PERSISTED_SNAPSHOT_VERSION,
  };

  try {
    storage.setItem(storageKey, JSON.stringify(envelope));
  } catch {
    // Ignore quota and serialization failures. Cache persistence is opportunistic.
  }
}

export function usePersistedDashboardSWR<Data, Error = unknown>(
  key: Key,
  fetcher: BareFetcher<Data> | null,
  config: SWRConfiguration<Data, Error> = {},
  persistedConfig?: PersistedDashboardSnapshotConfig<Data>
): SWRResponse<Data, Error> {
  const { dashboardCacheScope, selectedProjectId } = useDashboardWorkspace();
  const scopeKey = useMemo(
    () =>
      getDashboardCacheScopeKey(dashboardCacheScope, {
        projectId: selectedProjectId,
      }),
    [dashboardCacheScope, selectedProjectId]
  );
  const persistedKey = persistedConfig?.key;
  const persistedTtlMs = persistedConfig?.ttlMs;
  const persistedVersion = persistedConfig?.version ?? DEFAULT_PERSISTED_SNAPSHOT_VERSION;
  const persistedStorage = persistedConfig?.storage ?? "local";
  const persistedShouldPersist = persistedConfig?.shouldPersist;
  const normalizedPersistedConfig = useMemo<PersistedDashboardSnapshotConfig<Data> | undefined>(
    () =>
      persistedKey && typeof persistedTtlMs === "number"
        ? {
            key: persistedKey,
            ttlMs: persistedTtlMs,
            version: persistedVersion,
            storage: persistedStorage,
            shouldPersist: persistedShouldPersist,
          }
        : undefined,
    [persistedKey, persistedShouldPersist, persistedStorage, persistedTtlMs, persistedVersion]
  );

  // The server has no storage, so hydration reads none either and the stored snapshot arrives on
  // the render after; a client-side navigation reads it on its first render.
  const storedSnapshot = useSyncExternalStore(
    subscribeToStorage,
    () => readStoredSnapshot(scopeKey, normalizedPersistedConfig),
    readNoStoredSnapshot
  );

  const persistedFallbackData = useMemo(() => {
    if (!normalizedPersistedConfig || config.fallbackData !== undefined) {
      return undefined;
    }

    return parsePersistedDashboardSnapshot<Data>(
      storedSnapshot,
      scopeKey,
      normalizedPersistedConfig
    );
  }, [config.fallbackData, normalizedPersistedConfig, scopeKey, storedSnapshot]);

  const fallbackData =
    config.fallbackData !== undefined ? config.fallbackData : persistedFallbackData;

  const response = useSWR<Data, Error>(key, fetcher, {
    ...config,
    fallbackData,
  });

  useEffect(() => {
    if (!normalizedPersistedConfig || response.data === undefined || response.error) {
      return;
    }

    if (normalizedPersistedConfig.shouldPersist?.(response.data) === false) {
      return;
    }

    writePersistedDashboardSnapshot(scopeKey, normalizedPersistedConfig, response.data);
  }, [normalizedPersistedConfig, response.data, response.error, scopeKey]);

  return response;
}
