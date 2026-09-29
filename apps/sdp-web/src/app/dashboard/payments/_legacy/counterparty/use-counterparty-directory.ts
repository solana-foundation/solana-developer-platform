"use client";

import type { Counterparty, ListCounterpartiesResponse } from "@sdp/types";
import { useEffect, useRef, useState } from "react";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import { COUNTERPARTY_PAGE_SIZE } from "./counterparty-page.data";

interface UseCounterpartyDirectoryResult {
  page: number;
  setPage: (page: number) => void;
  counterparties: Counterparty[];
  total: number;
  pageCount: number;
  summary: string;
  loading: boolean;
  error: string | null;
  /** Optimistically drop a counterparty from the current page before the server confirms. */
  removeOptimistic: (counterpartyId: string) => void;
}

/**
 * Server-driven pagination for the counterparty directory. Page 1 is seeded
 * from the SSR payload; subsequent pages are fetched through the dashboard proxy
 * so the API does the slicing via its page/pageSize parameters.
 */
export function useCounterpartyDirectory(
  initialCounterparties: Counterparty[],
  initialTotal: number
): UseCounterpartyDirectoryResult {
  const pageSize = COUNTERPARTY_PAGE_SIZE;
  const [page, setPage] = useState(1);
  const [counterparties, setCounterparties] = useState(initialCounterparties);
  const [total, setTotal] = useState(initialTotal);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadedPageRef = useRef(1);

  useEffect(() => {
    setCounterparties(initialCounterparties);
    setTotal(initialTotal);
    setPage(1);
    loadedPageRef.current = 1;
  }, [initialCounterparties, initialTotal]);

  useEffect(() => {
    if (page === loadedPageRef.current) {
      return;
    }

    let aborted = false;
    setLoading(true);
    setError(null);

    void dashboardFetch<{ data: ListCounterpartiesResponse }>(
      `/api/dashboard/counterparty?page=${page}&pageSize=${pageSize}`
    ).then((result) => {
      if (aborted) return;
      if (result.ok) {
        setCounterparties(result.data.data.counterparties);
        setTotal(result.data.data.total);
        loadedPageRef.current = page;
      } else {
        setError(result.error);
      }
      setLoading(false);
    });

    return () => {
      aborted = true;
    };
  }, [page]);

  function removeOptimistic(counterpartyId: string) {
    setCounterparties((prev) => prev.filter((cp) => cp.id !== counterpartyId));
    setTotal((prev) => Math.max(0, prev - 1));
  }

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const summary =
    total === 0
      ? "0 of 0"
      : `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total}`;

  return {
    page,
    setPage,
    counterparties,
    total,
    pageCount,
    summary,
    loading,
    error,
    removeOptimistic,
  };
}
