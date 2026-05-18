"use client";

import { useEffect, useMemo } from "react";
import useSWR, { type BareFetcher, type Key, type SWRConfiguration, type SWRResponse } from "swr";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { getDashboardCacheScopeKey } from "@/lib/dashboard-cache-scope";

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

const DASHBOARD_CACHE_STORAGE_PREFIX = "sdp.dashboard.cache";
const DEFAULT_PERSISTED_SNAPSHOT_VERSION = 1;

function getStorage(storage: "local" | "session" = "local"): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }

  return storage === "session" ? window.sessionStorage : window.localStorage;
}

function buildScopedSnapshotKey(scopeKey: string, key: string): string {
  return `${DASHBOARD_CACHE_STORAGE_PREFIX}.${scopeKey}.${key}`;
}

function readPersistedDashboardSnapshot<Data>(
  scopeKey: string,
  config: PersistedDashboardSnapshotConfig<Data>
): Data | undefined {
  const storage = getStorage(config.storage);
  if (!storage) {
    return undefined;
  }

  const storageKey = buildScopedSnapshotKey(scopeKey, config.key);
  const rawValue = storage.getItem(storageKey);
  if (!rawValue) {
    return undefined;
  }

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
    storage.removeItem(storageKey);
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
  const { dashboardCacheScope } = useDashboardWorkspace();
  const scopeKey = useMemo(
    () => getDashboardCacheScopeKey(dashboardCacheScope),
    [dashboardCacheScope]
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

  const persistedFallbackData = useMemo(() => {
    if (!normalizedPersistedConfig || config.fallbackData !== undefined) {
      return undefined;
    }

    return readPersistedDashboardSnapshot<Data>(scopeKey, normalizedPersistedConfig);
  }, [config.fallbackData, normalizedPersistedConfig, scopeKey]);

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
