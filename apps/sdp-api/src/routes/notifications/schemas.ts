import { NOTIFICATION_CATEGORIES, NOTIFICATION_CHANNELS } from "@sdp/types";
import { z } from "zod";

// Partial upsert: only the cells sent are written; the response is always the full
// effective matrix. Max entries = one full matrix (every category × channel).
export const updatePreferencesSchema = z
  .object({
    preferences: z
      .array(
        z
          .object({
            category: z.enum(NOTIFICATION_CATEGORIES),
            channel: z.enum(NOTIFICATION_CHANNELS),
            enabled: z.boolean(),
          })
          .strict()
      )
      .min(1)
      .max(NOTIFICATION_CATEGORIES.length * NOTIFICATION_CHANNELS.length),
  })
  .strict();
