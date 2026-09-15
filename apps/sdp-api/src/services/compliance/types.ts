export type ComplianceProviderName = "range" | "elliptic" | "trm" | "chainalysis";

export type ComplianceScreeningIntent =
  | "transfer_destination"
  | "wallet_address_addition"
  | "unknown";

/**
 * Normalized decision, deliberately narrower than any provider's own status
 * space (HOO-1012):
 *  - `ok`          — the provider COMPLETED the screening and returned an
 *                    unambiguous verdict; only this value may read as a pass.
 *  - `pending`     — the provider accepted the request but has not finished
 *                    (e.g. Chainalysis non-COMPLETE); never a pass.
 *  - `unavailable` — the provider is not configured for this deployment.
 *  - `error`       — the call failed, or the response was malformed or
 *                    ambiguous; fail closed rather than guess.
 */
export type ComplianceScreeningStatus = "ok" | "pending" | "unavailable" | "error";

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
  /**
   * The provider's own status word, verbatim, retained for audit. The
   * normalized `status` is the decision; this is the evidence.
   */
  providerStatus?: string;
  message?: string;
  evaluatedAt: string;
}

export interface ComplianceProvider {
  readonly name: ComplianceProviderName;
  screenAddress(input: ComplianceAddressScreeningInput): Promise<ComplianceProviderResult>;
}
