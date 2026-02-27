import type {
  ComplianceAddressScreeningInput,
  ComplianceProvider,
  ComplianceProviderResult,
} from "../types";

const DEFAULT_TRM_API_BASE_URL = "https://api.trmlabs.com";
const TRM_ADDRESS_SCREENING_PATH = "/public/v2/screening/addresses";

type TrmAddressScreeningResponse = Array<{
  addressHighestRiskScoreLevel?: unknown;
  addressHighestRiskScoreLevelLabel?: unknown;
}>;

export interface TrmComplianceProviderConfig {
  apiKey?: string;
  baseUrl?: string;
}

function normalizeTrmApiBaseUrl(baseUrl: string | undefined): string {
  const value = (baseUrl ?? DEFAULT_TRM_API_BASE_URL).trim();
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function extractErrorMessage(body: string): string {
  if (!body) {
    return "";
  }

  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown };
    if (typeof parsed.error?.message === "string") {
      return parsed.error.message;
    }
    if (typeof parsed.message === "string") {
      return parsed.message;
    }
  } catch {
    // Fall back to raw body when response is not JSON.
  }

  return body;
}

export class TrmComplianceProvider implements ComplianceProvider {
  readonly name = "trm" as const;

  constructor(private readonly config: TrmComplianceProviderConfig) {}

  async screenAddress(input: ComplianceAddressScreeningInput): Promise<ComplianceProviderResult> {
    const evaluatedAt = new Date().toISOString();
    const apiKey = this.config.apiKey?.trim();

    if (!apiKey) {
      return {
        provider: this.name,
        status: "unavailable",
        riskScore: null,
        message: "TRM_API_KEY is not configured.",
        evaluatedAt,
      };
    }

    const baseUrl = normalizeTrmApiBaseUrl(this.config.baseUrl);
    const payload = JSON.stringify([
      {
        address: input.address,
        chain: input.network.toLowerCase(),
      },
    ]);
    const authToken = btoa(`${apiKey}:${apiKey}`);

    try {
      const url = new URL(TRM_ADDRESS_SCREENING_PATH, baseUrl);
      const response = await fetch(url.toString(), {
        method: "POST",
        headers: {
          Authorization: `Basic ${authToken}`,
          "Content-Type": "application/json",
        },
        body: payload,
      });

      if (!response.ok) {
        const body = extractErrorMessage(await response.text().catch(() => ""));
        return {
          provider: this.name,
          status: "error",
          riskScore: null,
          message: body
            ? `TRM request failed (${response.status}) at ${TRM_ADDRESS_SCREENING_PATH}: ${body}`
            : `TRM request failed (${response.status}) at ${TRM_ADDRESS_SCREENING_PATH}`,
          evaluatedAt,
        };
      }

      const result = (await response.json().catch(() => [])) as TrmAddressScreeningResponse;
      const first = Array.isArray(result) ? result[0] : undefined;
      const riskScore =
        typeof first?.addressHighestRiskScoreLevel === "number"
          ? first.addressHighestRiskScoreLevel
          : null;
      const riskLevel =
        typeof first?.addressHighestRiskScoreLevelLabel === "string"
          ? first.addressHighestRiskScoreLevelLabel
          : undefined;

      return {
        provider: this.name,
        status: "ok",
        riskScore,
        ...(riskLevel ? { riskLevel } : {}),
        evaluatedAt,
      };
    } catch (error) {
      return {
        provider: this.name,
        status: "error",
        riskScore: null,
        message: error instanceof Error ? error.message : "Failed to call TRM API",
        evaluatedAt,
      };
    }
  }
}
