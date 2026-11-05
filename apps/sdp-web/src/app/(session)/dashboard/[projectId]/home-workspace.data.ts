"use client";

import { z } from "zod";
import { useDashboardKeyScope, useDashboardRead } from "@/lib/dashboard-swr";
import { homeActivityRowSchema, todaysVolumeSchema } from "./home-page.data";
import { homeQueryKeys } from "./home-query-key";

const homeActivityResponseSchema = z.object({
  data: z.object({
    activityRows: z.array(homeActivityRowSchema),
    activityError: z.string().nullable(),
    activityNotice: z.string().nullable(),
    todaysVolume: todaysVolumeSchema.nullable(),
    todaysVolumeError: z.string().nullable(),
  }),
});

export type HomeActivitySnapshot = z.infer<typeof homeActivityResponseSchema>["data"];

/** Once a minute: every read fans out per wallet, and focus re-reads on return to the tab. */
const HOME_ACTIVITY_REFRESH_MS = 60_000;

/**
 * The activity snapshot both Home designs read. Pass `enabled: false` while neither the list nor
 * the volume is on screen, and nothing is read or polled. Parsed, not cast: a malformed body is an
 * error, never "no activity" or a $0.00 day.
 */
export function useHomeActivitySnapshot(enabled: boolean) {
  const scope = useDashboardKeyScope();
  const response = useDashboardRead(
    enabled ? homeQueryKeys.activity(scope) : null,
    homeActivityResponseSchema,
    { revalidateOnFocus: true, refreshInterval: HOME_ACTIVITY_REFRESH_MS }
  );
  return { data: response.data?.data, error: response.error };
}
