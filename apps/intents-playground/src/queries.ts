// What the playground reads from the service and the local wallet, as react-query queries. Each
// query's key names what it reads, so a component asks for data and never fetches it by hand.

import {
  keepPreviousData,
  QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { api, interfaceForm, ServiceError } from "@/api";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false, staleTime: Number.POSITIVE_INFINITY },
  },
});

/// The indexer reads a landed transaction a moment after it lands, so the ring reads again after it.
const INDEXER_LAG_MS = 3000;

export function useRegistry() {
  return useQuery({ queryKey: ["registry"], queryFn: api.registry });
}

export function useWallets() {
  return useQuery({ queryKey: ["wallets"], queryFn: api.wallets });
}

/// The form of one interface version, from its definition.
export function useInterfaceForm(id: string | null, version: string | null) {
  return useQuery({
    queryKey: ["interface", id, version],
    queryFn: () =>
      api
        .interfaceVersion(id ?? "", version ?? "")
        .then((published) => interfaceForm(published.document)),
    enabled: id !== null && version !== null,
  });
}

/// Each implementation of the interface with its status for `body`, read 250 ms after the inputs
/// stop changing. The last answer stays while the next one loads.
export function useMatches(id: string | null, version: string | null, body: object | null) {
  const settled = useDebounced(body === null ? null : JSON.stringify(body), 250);

  return useQuery({
    queryKey: ["matches", id, version, settled],
    queryFn: () => api.matches(id ?? "", version ?? "", JSON.parse(settled ?? "{}")),
    enabled: id !== null && version !== null && settled !== null,
    placeholderData: keepPreviousData,
    staleTime: 0,
  });
}

export function useImplementationVersion(id: string | null, version: string | null) {
  return useQuery({
    queryKey: ["implementation", id, version],
    queryFn: () => api.implementationVersion(id ?? "", version ?? ""),
    enabled: id !== null && version !== null,
  });
}

export function useCircuitVersion(id: string, version: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["circuit", id, version],
    queryFn: () => api.circuitVersion(id, version ?? ""),
    enabled: enabled && version !== null,
  });
}

/// Each local wallet's private balances. `noRing` means the wallet started without Privacy Rings.
export function useRing() {
  const ring = useQuery({ queryKey: ["ring"], queryFn: api.ring, staleTime: 0 });
  const noRing = ring.error instanceof ServiceError && ring.error.code === "noRing";

  return { ...ring, noRing };
}

/// Reads the ring again once the indexer has read a transaction that just landed.
export function useRefreshRing() {
  const client = useQueryClient();

  return () => {
    setTimeout(() => client.invalidateQueries({ queryKey: ["ring"] }), INDEXER_LAG_MS);
  };
}

export function useShield() {
  const refresh = useRefreshRing();

  return useMutation({
    mutationFn: ({ address, lamports }: { address: string; lamports: number }) =>
      api.shield(address, lamports),
    onSuccess: refresh,
  });
}

export function useAdapterMode() {
  return useMutation({ mutationFn: api.adapterMode });
}

/// `value`, once it has not changed for `delay` milliseconds.
function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);

    return () => clearTimeout(timer);
  }, [value, delay]);

  return settled;
}
