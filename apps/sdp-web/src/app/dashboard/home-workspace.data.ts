"use client";

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

function getApiError(
  body: HomeActivityResponseEnvelope | HomeVolumeResponseEnvelope,
  fallback: string
): string {
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

interface HomeVolumeResponseEnvelope {
  data?: {
    todaysVolume?: number | null;
    todaysVolumeError?: string | null;
  };
  error?: {
    message?: string;
  };
}

export interface HomeVolumeSnapshot {
  todaysVolume: number | null;
  /** Set when not every wallet's transfers loaded, so the volume would be understated. */
  todaysVolumeError: string | null;
}

/** Today's volume, read apart from the activity list because it waits on every wallet. */
export async function fetchHomeVolume(
  options: { signal?: AbortSignal } = {}
): Promise<HomeVolumeSnapshot> {
  const response = await fetch("/api/dashboard/home/volume", {
    method: "GET",
    cache: "no-store",
    signal: options.signal,
  });
  const body = (await response.json().catch(() => ({}))) as HomeVolumeResponseEnvelope;

  if (!response.ok) {
    throw new Error(getApiError(body, ""));
  }

  return {
    todaysVolume: body.data?.todaysVolume ?? null,
    todaysVolumeError: body.data?.todaysVolumeError ?? null,
  };
}
