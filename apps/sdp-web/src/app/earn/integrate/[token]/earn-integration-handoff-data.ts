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

/**
 * Three-way on purpose. Only a 404 is proof the token resolves nothing —
 * "missing" and the page may honestly 404. Every other non-OK answer (the
 * endpoint sits in the shared anonymous rate bucket, so a burst of opens 429s;
 * a deploy can 503) says nothing about the token, so it is "unavailable": the
 * page renders a retryable notice rather than a hard 500 (the pre-review
 * behavior) or a not-found that tells a partner their valid link is dead.
 */
export type PublicEarnButtonConfigurationLoad =
  | { kind: "found"; configuration: PublicEarnButtonConfiguration }
  | { kind: "missing" }
  | { kind: "unavailable" };

export async function loadPublicEarnButtonConfiguration(
  apiBaseUrl: string,
  token: string
): Promise<PublicEarnButtonConfigurationLoad> {
  const response = await fetch(
    `${apiBaseUrl}/v1/earn/button-configurations/public/${encodeURIComponent(token)}`,
    { cache: "no-store" }
  );
  if (response.status === 404) return { kind: "missing" };
  if (!response.ok) return { kind: "unavailable" };

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
  return { kind: "found", configuration: parsed.data.data.configuration };
}
