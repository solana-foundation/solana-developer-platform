import { z } from "zod";

// A webhook URL is where a future dispatcher would POST this project's events,
// so it is validated as a tenant-controlled endpoint now, while nothing dials
// it yet: https only. `z.string().url()` alone admits every scheme URL() parses
// — including ones that would leak or act if ever fetched naively.
const httpsWebhookUrl = z
  .string()
  .url()
  .refine((value) => new URL(value).protocol === "https:", {
    message: "webhookUrl must be an https URL",
  });

export const updateProjectSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  settings: z
    .strictObject({
      webhookUrl: httpsWebhookUrl.optional(),
      metadata: z.record(z.string(), z.string()).optional(),
    })
    .nullable()
    .optional(),
});
