import { isoDateTimeSchema, z } from "./base";

export const complianceIntentSchema = z
  .enum(["transfer_destination", "wallet_address_addition", "unknown"])
  .openapi({
    description: "Business intent for address screening.",
    example: "transfer_destination",
  });

export const complianceProviderNameSchema = z
  .enum(["range", "elliptic", "trm", "chainalysis"])
  .openapi({ description: "Compliance provider identifier.", example: "range" });

export const complianceProviderStatusSchema = z
  .enum(["ok", "unavailable", "error"])
  .openapi({ description: "Provider response status.", example: "ok" });

export const addressScreeningRequestSchema = z
  .object({
    address: z.string().min(1).openapi({
      description: "Address to screen.",
      example: "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ",
    }),
    network: z.string().min(1).max(64).default("solana").openapi({
      description: "Network identifier expected by the compliance provider.",
      example: "solana",
    }),
    intent: complianceIntentSchema.default("unknown"),
  })
  .openapi({ description: "Address compliance screening request payload." });

export const complianceProviderResultSchema = z
  .object({
    provider: complianceProviderNameSchema,
    status: complianceProviderStatusSchema,
    riskScore: z.number().nullable().openapi({
      description: "Risk score returned by the provider.",
      example: 7,
    }),
    riskLevel: z.string().optional().openapi({
      description: "Provider-specific risk level label.",
      example: "High risk",
    }),
    message: z.string().optional().openapi({
      description: "Optional provider message, such as warnings or error details.",
    }),
    evaluatedAt: isoDateTimeSchema.openapi({
      description: "Timestamp when the provider result was produced.",
      example: "2025-01-01T00:00:00.000Z",
    }),
  })
  .openapi({ description: "Address screening result for one provider." });

export const addressScreeningSchema = z
  .object({
    address: z.string().openapi({
      description: "Address that was screened.",
      example: "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ",
    }),
    network: z.string().openapi({
      description: "Network that was screened.",
      example: "solana",
    }),
    intent: complianceIntentSchema,
    checkedAt: isoDateTimeSchema.openapi({
      description: "Timestamp when all provider checks completed.",
      example: "2025-01-01T00:00:00.000Z",
    }),
    providers: z.array(complianceProviderResultSchema),
  })
  .openapi({ description: "Aggregated address screening response." });

export const addressScreeningResponseSchema = z
  .object({
    screening: addressScreeningSchema,
  })
  .openapi({ description: "Address screening response payload." });
