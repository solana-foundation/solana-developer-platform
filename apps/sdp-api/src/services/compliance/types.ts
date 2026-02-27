export type ComplianceProviderName = "range" | "elliptic" | "trm" | "chainalysis";

export type ComplianceScreeningIntent =
  | "transfer_destination"
  | "wallet_address_addition"
  | "unknown";

export type ComplianceScreeningStatus = "ok" | "unavailable" | "error";

export interface ComplianceAddressScreeningInput {
  address: string;
  network: string;
  intent: ComplianceScreeningIntent;
}

export interface ComplianceProviderResult {
  provider: ComplianceProviderName;
  status: ComplianceScreeningStatus;
  riskScore: number | null;
  riskLevel?: string;
  message?: string;
  evaluatedAt: string;
}

export interface ComplianceProvider {
  readonly name: ComplianceProviderName;
  screenAddress(input: ComplianceAddressScreeningInput): Promise<ComplianceProviderResult>;
}
