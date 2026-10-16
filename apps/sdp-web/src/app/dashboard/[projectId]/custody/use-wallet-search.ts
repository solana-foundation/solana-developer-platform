"use client";

import type { CustodyWalletSummary } from "@sdp/types";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useDashboardUrlState } from "@/lib/dashboard-url-state";
import { useDebounce } from "@/lib/use-debounce";
import {
  filterWallets,
  normalizeWalletSearchQuery,
  WALLET_SEARCH_QUERY_PARAM,
} from "./wallet-search";

interface WalletSearch {
  searchValue: string;
  normalizedSearch: string;
  visibleWallets: CustodyWalletSummary[];
  searchIsPending: boolean;
  updateSearchValue: (value: string) => void;
  clearSearch: () => void;
}

/**
 * Wallet search state kept in sync with the dashboard URL query param in both directions:
 * typing writes the debounced query to the URL, and URL navigation replaces the typed value.
 *
 * @param wallets - The project's wallets to filter.
 * @returns The typed value, its normalized form, the matching wallets, whether the deferred
 *   filter is still catching up, and the update/clear handlers.
 */
export function useWalletSearch(wallets: CustodyWalletSummary[]): WalletSearch {
  const { replaceSearchParams, searchParams } = useDashboardUrlState();
  const initialSearch = normalizeWalletSearchQuery(
    searchParams.get(WALLET_SEARCH_QUERY_PARAM) ?? ""
  );
  const [searchValue, setSearchValue] = useState(initialSearch);
  const deferredSearchValue = useDeferredValue(searchValue);
  const effectiveSearchValue = normalizeWalletSearchQuery(searchValue)
    ? deferredSearchValue
    : searchValue;
  const debouncedSearch = useDebounce(normalizeWalletSearchQuery(searchValue), 200);
  const lastUrlSearchRef = useRef(initialSearch);
  const syncingFromUrlRef = useRef<string | null>(null);
  const normalizedSearch = normalizeWalletSearchQuery(effectiveSearchValue);
  const visibleWallets = useMemo(
    () => filterWallets(wallets, normalizedSearch),
    [normalizedSearch, wallets]
  );
  const searchIsPending = deferredSearchValue !== searchValue;

  useEffect(() => {
    const urlSearch = normalizeWalletSearchQuery(searchParams.get(WALLET_SEARCH_QUERY_PARAM) ?? "");
    if (urlSearch === lastUrlSearchRef.current) return;

    lastUrlSearchRef.current = urlSearch;
    syncingFromUrlRef.current = urlSearch;
    setSearchValue(urlSearch);
  }, [searchParams]);

  useEffect(() => {
    if (syncingFromUrlRef.current !== null) {
      if (debouncedSearch === syncingFromUrlRef.current) {
        syncingFromUrlRef.current = null;
      }
      return;
    }
    if (debouncedSearch === lastUrlSearchRef.current) return;

    lastUrlSearchRef.current = debouncedSearch;
    replaceSearchParams({
      [WALLET_SEARCH_QUERY_PARAM]: debouncedSearch || null,
    });
  }, [debouncedSearch, replaceSearchParams]);

  const updateSearchValue = (value: string) => {
    syncingFromUrlRef.current = null;
    setSearchValue(value);
  };

  const clearSearch = () => {
    lastUrlSearchRef.current = "";
    syncingFromUrlRef.current = null;
    setSearchValue("");
    replaceSearchParams({ [WALLET_SEARCH_QUERY_PARAM]: null });
  };

  return {
    searchValue,
    normalizedSearch,
    visibleWallets,
    searchIsPending,
    updateSearchValue,
    clearSearch,
  };
}
