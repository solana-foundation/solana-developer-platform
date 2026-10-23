"use client";

import { z } from "zod";
import { dashboardRequest } from "@/lib/dashboard-fetch";
import { usePersistedDashboardSWR } from "@/lib/dashboard-swr";
import { homeActivityRowSchema } from "./home-page.data";
import { homeQueryKeys } from "./home-query-key";

const homeActivityResponseSchema = z.object({
  data: z.object({
    activityRows: z.array(homeActivityRowSchema),
    activityError: z.string().nullable(),
    activityNotice: z.string().nullable(),
    todaysVolume: z.number().nullable(),
    todaysVolumeError: z.string().nullable(),
  }),
});

export type HomeActivitySnapshot = z.infer<typeof homeActivityResponseSchema>["data"];

/** Once a minute: every read fans out per wallet, and focus re-reads on return to the tab. */
const HOME_ACTIVITY_REFRESH_MS = 60_000;
const HOME_ACTIVITY_CACHE_TTL_MS = 60_000;
/** The saved snapshot's shape: bump it with any change to the route's answer, so a browser
 * holding the old shape drops it instead of drawing it. */
const HOME_ACTIVITY_SNAPSHOT_VERSION = 2;

/**
 * Home's activity list and today's volume, from the one route that builds both. Parsed, not
 * cast: a malformed body is an error, never "no activity" or a $0.00 day.
 */
export async function fetchHomeActivity(
  options: { signal?: AbortSignal } = {}
): Promise<HomeActivitySnapshot> {
  const response = await dashboardRequest("/api/dashboard/home/activity", {
    method: "GET",
    cache: "no-store",
    signal: options.signal,
  });
  const body = homeActivityResponseSchema.safeParse(await response.json().catch(() => null));

  if (!response.ok || !body.success) {
    // No message: each section words its own failure, and the route's text is for its logs.
    throw new Error();
  }

  return body.data.data;
}

/**
 * The activity snapshot both Home designs read. Pass `enabled: false` while neither the list nor
 * the volume is on screen, and nothing is read or polled.
 */
export function useHomeActivitySnapshot(enabled: boolean) {
  return usePersistedDashboardSWR(
    enabled ? homeQueryKeys.activity() : null,
    () => fetchHomeActivity(),
    {
      revalidateOnFocus: true,
      refreshInterval: HOME_ACTIVITY_REFRESH_MS,
    },
    {
      key: "home-activity",
      ttlMs: HOME_ACTIVITY_CACHE_TTL_MS,
      version: HOME_ACTIVITY_SNAPSHOT_VERSION,
    }
  );
}
