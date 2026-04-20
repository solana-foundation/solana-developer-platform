"use client";

import type { HomeActivityRow } from "./home-page.data";

interface HomeActivityResponseEnvelope {
  data?: {
    todaysVolume?: number | null;
    activityRows?: HomeActivityRow[];
    activityError?: string | null;
    activityNotice?: string | null;
  };
  error?: {
    message?: string;
  };
}

export interface HomeActivitySnapshot {
  todaysVolume: number | null;
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
    throw new Error(getApiError(body, `Home activity request failed (${response.status}).`));
  }

  return {
    todaysVolume: body.data?.todaysVolume ?? null,
    activityRows: body.data?.activityRows ?? [],
    activityError: body.data?.activityError ?? null,
    activityNotice: body.data?.activityNotice ?? null,
  };
}
