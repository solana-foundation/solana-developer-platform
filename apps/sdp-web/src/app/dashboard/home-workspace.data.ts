"use client";

import { z } from "zod";
import type { HomeActivityRow } from "./home-page.data";

interface HomeActivityResponseEnvelope {
  data?: {
    activityRows?: HomeActivityRow[];
    activityError?: string | null;
    activityNotice?: string | null;
  };
  error?: {
    message?: string;
  };
}

export interface HomeActivitySnapshot {
  activityRows: HomeActivityRow[];
  activityError: string | null;
  activityNotice: string | null;
}

function getApiError(body: HomeActivityResponseEnvelope, fallback: string): string {
  if (typeof body.error?.message === "string" && body.error.message) {
    return body.error.message;
  }

  return fallback;
}

export async function fetchHomeActivity(
  options: { signal?: AbortSignal } = {}
): Promise<HomeActivitySnapshot> {
  const response = await fetch("/api/dashboard/home/activity", {
    method: "GET",
    cache: "no-store",
    signal: options.signal,
  });
  const body = (await response.json().catch(() => ({}))) as HomeActivityResponseEnvelope;

  if (!response.ok) {
    throw new Error(getApiError(body, ""));
  }

  return {
    activityRows: body.data?.activityRows ?? [],
    activityError: body.data?.activityError ?? null,
    activityNotice: body.data?.activityNotice ?? null,
  };
}

/** The volume route's answer. Parsed, not cast: a malformed body is an error, never "no volume". */
const homeVolumeResponseSchema = z.object({
  data: z.object({
    todaysVolume: z.number().nullable(),
    todaysVolumeError: z.string().nullable(),
  }),
});

const homeVolumeErrorSchema = z.object({ error: z.string().min(1) });

export type HomeVolumeSnapshot = z.infer<typeof homeVolumeResponseSchema>["data"];

/** Today's volume, read apart from the activity list because it waits on every wallet. */
export async function fetchHomeVolume(
  options: { signal?: AbortSignal } = {}
): Promise<HomeVolumeSnapshot> {
  const response = await fetch("/api/dashboard/home/volume", {
    method: "GET",
    cache: "no-store",
    signal: options.signal,
  });
  const body: unknown = await response.json();

  if (!response.ok) {
    const failure = homeVolumeErrorSchema.safeParse(body);
    throw new Error(
      failure.success ? failure.data.error : `Volume request failed (${response.status})`
    );
  }

  return homeVolumeResponseSchema.parse(body).data;
}
