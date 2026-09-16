"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  createNetworkDebugRequestId,
  getStoredNetworkDebugEnabled,
  isNetworkDebugAvailable,
  MAX_NETWORK_DEBUG_ENTRIES,
  matchNetworkDebugFetch,
  type NetworkDebugEntry,
  readNetworkDebugRequestBody,
  readNetworkDebugResponseBody,
  resolveNetworkDebugFetchMethod,
  setStoredNetworkDebugEnabled,
  toNetworkDebugErrorMessage,
  toNetworkDebugRequestState,
} from "@/lib/network-debug";

export type { NetworkDebugEntry, NetworkDebugRequestState } from "@/lib/network-debug";

interface NetworkDebugContextValue {
  available: boolean;
  enabled: boolean;
  paused: boolean;
  entries: NetworkDebugEntry[];
  pendingCount: number;
  setEnabled: (enabled: boolean) => void;
  setPaused: (paused: boolean) => void;
  clear: () => void;
}

const NetworkDebugContext = createContext<NetworkDebugContextValue | undefined>(undefined);

function roundDurationMs(startedAtMs: number): number {
  return Math.round((performance.now() - startedAtMs) * 10) / 10;
}

function useNetworkDebugFetchPatch({
  available,
  enabled,
  paused,
  setEntries,
}: {
  available: boolean;
  enabled: boolean;
  paused: boolean;
  setEntries: React.Dispatch<React.SetStateAction<NetworkDebugEntry[]>>;
}) {
  const sequenceRef = useRef(0);
  const pausedRef = useRef(paused);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    if (!available || !enabled) {
      return;
    }

    const originalFetch = window.fetch;

    window.fetch = async (input, init) => {
      const match = matchNetworkDebugFetch(input);
      if (!match || pausedRef.current) {
        return originalFetch(input, init);
      }

      const startedAt = Date.now();
      const startedAtMs = performance.now();
      const debugRequestId = createNetworkDebugRequestId(sequenceRef.current++);
      const patchEntry = (patch: Partial<NetworkDebugEntry>) =>
        setEntries((current) =>
          current.map((entry) =>
            entry.debug_request_id === debugRequestId ? { ...entry, ...patch } : entry
          )
        );
      void readNetworkDebugRequestBody(input, init).then((requestBody) => {
        if (requestBody) {
          patchEntry({ requestBody });
        }
      });
      setEntries((current) =>
        [
          {
            debug_request_id: debugRequestId,
            method: resolveNetworkDebugFetchMethod(input, init),
            path: match.path,
            query: match.query,
            startedAt,
            state: "pending" as const,
          },
          ...current,
        ].slice(0, MAX_NETWORK_DEBUG_ENTRIES)
      );

      try {
        const response = await originalFetch(input, init);
        void readNetworkDebugResponseBody(response).then((responseBody) =>
          patchEntry({
            durationMs: roundDurationMs(startedAtMs),
            endedAt: Date.now(),
            state: "success",
            status: response.status,
            responseBody,
          })
        );
        return response;
      } catch (error) {
        patchEntry({
          durationMs: roundDurationMs(startedAtMs),
          endedAt: Date.now(),
          error: toNetworkDebugErrorMessage(error),
          state: toNetworkDebugRequestState(error),
        });
        throw error;
      }
    };

    return () => {
      window.fetch = originalFetch;
    };
  }, [available, enabled, setEntries]);
}

export function NetworkDebugProvider({ children }: { children: ReactNode }) {
  const available = isNetworkDebugAvailable();
  const [enabled, setEnabledState] = useState(false);
  const [paused, setPaused] = useState(false);
  const [entries, setEntries] = useState<NetworkDebugEntry[]>([]);

  useEffect(() => {
    if (available) {
      setEnabledState(getStoredNetworkDebugEnabled());
    }
  }, [available]);

  const setEnabled = useCallback(
    (nextEnabled: boolean) => {
      if (!available) {
        return;
      }

      setEnabledState(nextEnabled);
      setStoredNetworkDebugEnabled(nextEnabled);
    },
    [available]
  );

  const clear = useCallback(() => {
    setEntries([]);
  }, []);

  useNetworkDebugFetchPatch({ available, enabled, paused, setEntries });

  return (
    <NetworkDebugContext.Provider
      value={{
        available,
        clear,
        enabled,
        entries,
        paused,
        pendingCount: entries.filter((entry) => entry.state === "pending").length,
        setEnabled,
        setPaused,
      }}
    >
      {children}
    </NetworkDebugContext.Provider>
  );
}

export function useNetworkDebug() {
  const context = useContext(NetworkDebugContext);

  if (!context) {
    throw new Error("useNetworkDebug must be used within NetworkDebugProvider");
  }

  return context;
}
