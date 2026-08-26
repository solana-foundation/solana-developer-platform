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
      strategyAvailable: z.boolean(),
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
  // Any non-OK answer degrades to the not-found page, matching pay/[token]:
  // this endpoint sits in the shared anonymous rate bucket, so a burst of
  // opens (one team channel link) 429s — a hard 500 for every viewer is worse
  // than a soft miss they can retry.
  if (!response.ok) return null;

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
