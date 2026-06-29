import type { ComplianceProviderId } from "@sdp/types";

export type ComplianceIntent = "transfer_destination" | "wallet_address_addition" | "unknown";

export type ComplianceProviderResult = {
  provider: ComplianceProviderId;
  status: "ok" | "unavailable" | "error";
  riskScore: number | null;
  riskLevel?: string;
  message?: string;
  evaluatedAt: string;
};

export const COMPLIANCE_PROVIDER_LOGOS = {
  range: "/provider-logos/range-compliance.svg",
  elliptic: "/provider-logos/elliptic-compliance.svg",
  trm: "/provider-logos/trm-compliance.svg",
  chainalysis: "/provider-logos/chainalysis-compliance.svg",
} as const satisfies Record<ComplianceProviderId, string>;

export type AddressScreeningResult = {
  checkedAt: string;
  providers: ComplianceProviderResult[];
};

type AddressScreeningEnvelope = {
  data?: {
    screening?: {
      checkedAt?: string;
      providers?: ComplianceProviderResult[];
    };
  };
  error?: {
    message?: string;
  };
};

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
    throw new Error(toErrorMessage(payload, `Compliance request failed (${response.status}).`));
  }

  return {
    checkedAt: payload.data?.screening?.checkedAt ?? new Date().toISOString(),
    providers: payload.data?.screening?.providers ?? [],
  };
}
