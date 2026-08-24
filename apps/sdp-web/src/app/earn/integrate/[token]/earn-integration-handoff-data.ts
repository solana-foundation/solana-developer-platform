import {
  EARN_BUTTON_ACCENT_COLOR_PATTERN,
  EARN_BUTTON_STYLES,
  type PublicEarnButtonConfiguration,
} from "@sdp/types";
import { z } from "zod";

const responseSchema = z.object({
  data: z.object({
    configuration: z.object({
      strategyId: z.string().min(1),
      strategyName: z.string().nullable(),
      provider: z.string().nullable(),
      style: z.enum(EARN_BUTTON_STYLES),
      accentColor: z.string().regex(EARN_BUTTON_ACCENT_COLOR_PATTERN),
    }),
  }),
});

export async function loadPublicEarnButtonConfiguration(
  apiBaseUrl: string,
  token: string
): Promise<PublicEarnButtonConfiguration | null> {
  const response = await fetch(
    `${apiBaseUrl}/v1/earn/button-configurations/public/${encodeURIComponent(token)}`,
    { cache: "no-store" }
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Earn integration handoff request failed (${response.status})`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Earn integration handoff returned invalid JSON");
  }

  const parsed = responseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("Earn integration handoff returned an invalid response");
  }
  return parsed.data.data.configuration;
}
