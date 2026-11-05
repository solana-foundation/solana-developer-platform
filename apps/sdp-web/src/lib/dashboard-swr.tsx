"use client";

import { useCallback } from "react";
import useSWR, { type SWRConfiguration, type SWRResponse, useSWRConfig } from "swr";
import type { z } from "zod";
import { dashboardReadRequest } from "@/lib/dashboard-fetch";
import {
  type DashboardKeyScope,
  type DashboardRequestKey,
  dashboardRequestUrl,
  isDashboardRequestKey,
} from "@/lib/dashboard-request-key";
import { apiErrorCode } from "@/lib/idempotency";
import { usePaymentsDemo } from "@/lib/payments-demo/payments-demo-context";
import { useProjectId } from "@/lib/use-dashboard-project";

/** A read the BFF refused, or answered with a body its schema rejects (`status` 200, no `code`). */
export class DashboardReadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null
  ) {
    super(`Dashboard read failed (${status}${code === null ? "" : ` ${code}`})`);
    this.name = "DashboardReadError";
  }
}

/** The Project in this tab's URL and whether the screen runs in demo mode: what every key carries. */
export function useDashboardKeyScope(): DashboardKeyScope {
  const projectId = useProjectId();
  const demo = usePaymentsDemo();
  return { projectId, mode: demo ? "demo" : "live" };
}

export async function readDashboardRequest<Schema extends z.ZodType>(
  key: DashboardRequestKey,
  schema: Schema
): Promise<z.infer<Schema>> {
  const response = await dashboardReadRequest(dashboardRequestUrl(key), {
    projectId: key[0],
    demo: key[1] === "demo",
  });
  const text = await response.text();
  if (!response.ok) {
    throw new DashboardReadError(response.status, apiErrorCode(text));
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new DashboardReadError(response.status, null);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new DashboardReadError(response.status, null);
  }
  return parsed.data;
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
  return useSWR(
    key,
    (requestKey: DashboardRequestKey) => readDashboardRequest(requestKey, schema),
    config
  );
}

/**
 * After a write: every matching read refetches if it is on screen, and is cleared if it is not, so
 * the next visit shows a skeleton instead of the money it showed before the write. Infinite lists
 * are not matched (SWR skips them); they refresh through their own bound `mutate`.
 */
export function useInvalidateDashboardReads() {
  const { mutate } = useSWRConfig();
  return useCallback(
    (matches: (key: DashboardRequestKey) => boolean) =>
      mutate((key) => isDashboardRequestKey(key) && matches(key), undefined, { revalidate: true }),
    [mutate]
  );
}
