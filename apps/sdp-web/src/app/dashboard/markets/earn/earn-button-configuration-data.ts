"use client";

import {
  EARN_BUTTON_ACCENT_COLOR_PATTERN,
  EARN_BUTTON_STYLES,
  type EarnButtonConfiguration,
  type EarnButtonConfigurationResponse,
  type EarnButtonStyle,
} from "@sdp/types";
import { z } from "zod";
import { type DashboardFetchResult, dashboardFetch } from "@/lib/dashboard-fetch";
import { PROJECT_HEADER_NAME } from "@/lib/project-cookie";

const configurationSchema: z.ZodType<EarnButtonConfiguration> = z.object({
  id: z.string().min(1),
  strategyId: z.string().min(1),
  style: z.enum(EARN_BUTTON_STYLES),
  accentColor: z.string().regex(EARN_BUTTON_ACCENT_COLOR_PATTERN),
  publicToken: z
    .string()
    .length(24)
    .regex(/^[A-Za-z0-9_-]+$/),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

const responseSchema: z.ZodType<{ data: EarnButtonConfigurationResponse }> = z.object({
  data: z.object({ configuration: configurationSchema }),
});

export async function saveEarnButtonConfiguration(input: {
  projectId: string;
  strategyId: string;
  style: EarnButtonStyle;
  accentColor: string;
}): Promise<DashboardFetchResult<EarnButtonConfiguration>> {
  const { projectId, ...configuration } = input;
  const result = await dashboardFetch<unknown>("/api/dashboard/markets/earn/button-configuration", {
    method: "PUT",
    headers: { [PROJECT_HEADER_NAME]: projectId },
    body: configuration,
  });
  if (!result.ok) return result;

  const parsed = responseSchema.safeParse(result.data);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Invalid Earn button configuration response",
      status: result.status,
      body: result.data,
    };
  }
  return { ok: true, status: result.status, data: parsed.data.data.configuration };
}
