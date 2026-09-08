import { COMPLIANCE_PROVIDERS, type ComplianceProviderId } from "@sdp/types";
import { z } from "zod";

export type ComplianceIntent = "transfer_destination" | "wallet_address_addition" | "unknown";

const complianceProviderResultSchema = z.object({
  provider: z.enum(COMPLIANCE_PROVIDERS),
  status: z.enum(["ok", "pending", "unavailable", "error"]),
  riskScore: z.number().nullable(),
  riskLevel: z.string().optional(),
  providerStatus: z.string().optional(),
  message: z.string().optional(),
  evaluatedAt: z.string().min(1),
});

export type ComplianceProviderResult = z.infer<typeof complianceProviderResultSchema>;

export const COMPLIANCE_PROVIDER_LOGOS = {
  range: "/provider-logos/range-compliance.svg",
  elliptic: "/provider-logos/elliptic-compliance.svg",
  trm: "/provider-logos/trm-compliance.svg",
  chainalysis: "/provider-logos/chainalysis-compliance.svg",
} as const satisfies Record<ComplianceProviderId, string>;

type AddressScreeningEnvelope = {
  data?: unknown;
  error?: {
    message?: string;
  };
};

/**
 * A screening the dashboard cannot read is not an empty screening. Defaulting
 * a malformed or missing payload to `{ providers: [] }` turned a dropped
 * response into a silent "nothing flagged", which is the one thing a
 * compliance surface must never show (HOO-1012).
 */
const addressScreeningSchema = z.object({
  screening: z.object({
    checkedAt: z.string().min(1),
    providers: z.array(complianceProviderResultSchema),
  }),
});

export type AddressScreeningResult = z.infer<typeof addressScreeningSchema>["screening"];

export class ComplianceNotEnabledError extends Error {}

function toErrorMessage(payload: AddressScreeningEnvelope, fallback: string): string {
  if (typeof payload.error?.message === "string" && payload.error.message) {
    return payload.error.message;
  }
  return fallback;
}

export async function screenAddressCompliance(input: {
  address: string;
  network?: string;
  intent?: ComplianceIntent;
}): Promise<AddressScreeningResult> {
  const response = await fetch("/api/dashboard/compliance/address-screenings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      address: input.address,
      network: input.network ?? "solana",
      intent: input.intent ?? "unknown",
    }),
  });

  const payload = (await response.json().catch(() => ({}))) as AddressScreeningEnvelope;
  if (!response.ok) {
    const message = toErrorMessage(payload, `Compliance request failed (${response.status}).`);
    if (response.status === 403) {
      throw new ComplianceNotEnabledError(message);
    }
    throw new Error(message);
  }

  const parsed = addressScreeningSchema.safeParse(payload.data);
  if (!parsed.success) {
    throw new Error("Compliance response could not be read.");
  }

  return parsed.data.screening;
}
