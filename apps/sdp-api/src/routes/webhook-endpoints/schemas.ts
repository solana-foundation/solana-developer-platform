import { z } from "zod";
import { checkWebhookUrlSyntax } from "@/services/workflows/webhook-url";

// Same messages as the workflow-params `webhookUrl` refinement so the builder and the
// registry surface identical validation errors for the same URL.
const webhookUrl = z
  .string()
  .max(2_000)
  .superRefine((value, ctx) => {
    const checked = checkWebhookUrlSyntax(value);
    if (checked.ok) {
      return;
    }
    const message =
      checked.reason === "INSECURE_SCHEME"
        ? "Webhook URL must use https"
        : checked.reason === "PRIVATE_HOST"
          ? "Webhook URL must point at a public host"
          : "Webhook URL is not a valid URL";
    ctx.addIssue({ code: "custom", message });
  });

// Trimmed before the length checks so a whitespace-only label can't slip through as
// "non-empty" and render an invisible link in the registry table.
const endpointLabel = z.string().trim().min(1).max(120);

export const createEndpointSchema = z
  .object({
    url: webhookUrl,
    label: endpointLabel,
    description: z.string().max(500).optional(),
  })
  .strict();

// `url` is intentionally absent: it is immutable after create (create a new endpoint
// to change it) — silently repointing an endpoint would redirect every rule using it.
export const updateEndpointSchema = z
  .object({
    label: endpointLabel.optional(),
    description: z.string().max(500).nullable().optional(),
    status: z.enum(["active", "disabled"]).optional(),
  })
  .strict();

// Grace bounds mirror api-keys rotation (0–168h, default applied in the handler).
export const rotateSecretSchema = z
  .object({
    gracePeriodHours: z.number().min(0).max(168).optional(),
  })
  .strict();
