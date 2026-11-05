"use client";

import { useCallback, useEffect } from "react";
import useSWR, {
  type Arguments,
  type Cache,
  type SWRConfiguration,
  type SWRResponse,
  unstable_serialize,
  useSWRConfig,
} from "swr";
import type { z } from "zod";
import { readApiErrorMessage } from "@/lib/api-error";
import { dashboardReadRequest } from "@/lib/dashboard-fetch";
import {
  type DashboardKeyScope,
  type DashboardPostReadKey,
  type DashboardRequestKey,
  dashboardRequestUrl,
  isDashboardRequestKey,
} from "@/lib/dashboard-request-key";
import { apiErrorCode } from "@/lib/idempotency";
import { usePaymentsDemo } from "@/lib/payments-demo/payments-demo-context";
import { useProjectId } from "@/lib/use-dashboard-project";

/**
 * A read the BFF refused, or answered with a body its schema rejects (`status` 200, no `code`).
 * `message` is the API's own message or empty, so a section words its own failure.
 */
export class DashboardReadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    apiMessage: string | null
  ) {
    super(apiMessage ?? "");
    this.name = "DashboardReadError";
  }
}

/** The Project in this tab's URL and whether the screen runs in demo mode: what every key carries. */
export function useDashboardKeyScope(): DashboardKeyScope {
  const projectId = useProjectId();
  const demo = usePaymentsDemo();
  return { projectId, mode: demo ? "demo" : "live" };
}

async function parseDashboardRead<Schema extends z.ZodType>(
  response: Response,
  schema: Schema
): Promise<z.infer<Schema>> {
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new DashboardReadError(response.status, null, null);
  }
  if (!response.ok) {
    throw new DashboardReadError(
      response.status,
      apiErrorCode(text),
      readApiErrorMessage(json) ?? null
    );
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new DashboardReadError(response.status, null, null);
  }
  return parsed.data;
}

export async function readDashboardRequest<Schema extends z.ZodType>(
  key: DashboardRequestKey,
  schema: Schema
): Promise<z.infer<Schema>> {
  const response = await dashboardReadRequest(
    dashboardRequestUrl(key),
    { projectId: key[0], demo: key[1] === "demo" },
    undefined
  );
  return parseDashboardRead(response, schema);
}

/**
 * A POST read (an estimate or quote that changes nothing): the key's path is the URL and its
 * serialized body is sent as is, so two keys share an entry only when they send the same request.
 */
export async function readDashboardPostRequest<Schema extends z.ZodType>(
  key: DashboardPostReadKey,
  schema: Schema
): Promise<z.infer<Schema>> {
  const response = await dashboardReadRequest(
    key[2],
    { projectId: key[0], demo: key[1] === "demo" },
    key[3].body
  );
  return parseDashboardRead(response, schema);
}

const mountedReadCounts = new WeakMap<Cache, Map<string, number>>();

function mountedReadsOf(cache: Cache): Map<string, number> {
  const existing = mountedReadCounts.get(cache);
  if (existing !== undefined) {
    return existing;
  }
  const created = new Map<string, number>();
  mountedReadCounts.set(cache, created);
  return created;
}

/**
 * `useSWR` for a request key, counted while mounted so an invalidation can tell a read on screen
 * (refetch, keep its data) from one that is not (clear it). Every dashboard read goes through here.
 */
export function useDashboardSWR<Data, Key extends DashboardRequestKey = DashboardRequestKey>(
  key: Key | null,
  fetcher: (requestKey: Key) => Promise<Data>,
  config?: SWRConfiguration<Data, DashboardReadError>
): SWRResponse<Data, DashboardReadError> {
  const { cache } = useSWRConfig();
  const serializedKey = key === null ? null : unstable_serialize(key);
  useEffect(() => {
    if (serializedKey === null) {
      return;
    }
    const counts = mountedReadsOf(cache);
    counts.set(serializedKey, (counts.get(serializedKey) ?? 0) + 1);
    return () => {
      const remaining = (counts.get(serializedKey) ?? 1) - 1;
      if (remaining === 0) {
        counts.delete(serializedKey);
      } else {
        counts.set(serializedKey, remaining);
      }
    };
  }, [cache, serializedKey]);
  return useSWR(key, fetcher, config);
}

/**
 * Reads one BFF request through the dashboard cache. The key alone decides the URL, Project and
 * mode, and `schema` parses the whole response body; pass `null` as the key to read nothing.
 */
export function useDashboardRead<Schema extends z.ZodType>(
  key: DashboardRequestKey | null,
  schema: Schema,
  config?: SWRConfiguration<z.infer<Schema>, DashboardReadError>
): SWRResponse<z.infer<Schema>, DashboardReadError> {
  return useDashboardSWR(key, (requestKey) => readDashboardRequest(requestKey, schema), config);
}

/**
 * After a write: every matching read on screen refetches and keeps its data until the answer
 * lands; every matching read not on screen is cleared, so the next visit shows a skeleton instead
 * of the money it showed before the write. Infinite lists are not matched (SWR skips them); they
 * refresh through their own bound `mutate`.
 */
export function useInvalidateDashboardReads() {
  const { cache, mutate } = useSWRConfig();
  return useCallback(
    async (matches: (key: DashboardRequestKey) => boolean) => {
      const mountedReads = mountedReadsOf(cache);
      const isMatch = (key: Arguments): key is DashboardRequestKey =>
        isDashboardRequestKey(key) && matches(key);
      const offScreenKeys: string[] = [];
      await Promise.all([
        mutate((key) => isMatch(key) && mountedReads.has(unstable_serialize(key))),
        mutate(
          (key) => {
            const offScreen = isMatch(key) && !mountedReads.has(unstable_serialize(key));
            if (offScreen) {
              offScreenKeys.push(unstable_serialize(key));
            }
            return offScreen;
          },
          undefined,
          // With no hook mounted this fetches nothing, but it drops the key's in-flight request,
          // so a remount starts its own instead of joining one whose answer predates the write.
          { revalidate: true }
        ),
      ]);
      // Deleting the cleared entry makes the next mount start loading: it would otherwise keep
      // its last `isLoading: false` for one render.
      for (const serializedKey of offScreenKeys) {
        cache.delete(serializedKey);
      }
    },
    [cache, mutate]
  );
}
