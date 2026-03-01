import type {
  ComplianceAddressScreeningInput,
  ComplianceProvider,
  ComplianceProviderResult,
} from "../types";

const DEFAULT_RANGE_API_BASE_URL = "https://api.range.org";

type RangeAddressRiskResponse = {
  riskScore?: unknown;
  riskLevel?: unknown;
};

export interface RangeComplianceProviderConfig {
  apiKey?: string;
  baseUrl?: string;
}

function normalizeRangeApiBaseUrl(baseUrl: string | undefined): string {
  const value = (baseUrl ?? DEFAULT_RANGE_API_BASE_URL).trim();
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

export class RangeComplianceProvider implements ComplianceProvider {
  readonly name = "range" as const;

  constructor(private readonly config: RangeComplianceProviderConfig) {}

  async screenAddress(input: ComplianceAddressScreeningInput): Promise<ComplianceProviderResult> {
    const evaluatedAt = new Date().toISOString();
    const apiKey = this.config.apiKey?.trim();

    if (!apiKey) {
      return {
        provider: this.name,
        status: "unavailable",
        riskScore: null,
        message: "RANGE_API_KEY is not configured.",
        evaluatedAt,
      };
    }

    const baseUrl = normalizeRangeApiBaseUrl(this.config.baseUrl);
    const url = new URL("/v1/risk/address", baseUrl);
    url.searchParams.set("address", input.address);
    url.searchParams.set("network", input.network);

    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });

      if (!response.ok) {
        const body = extractErrorMessage(await response.text().catch(() => ""));
        return {
          provider: this.name,
          status: "error",
          riskScore: null,
          message: body
            ? `Range request failed (${response.status}): ${body}`
            : `Range request failed (${response.status})`,
          evaluatedAt,
        };
      }

      const payload = (await response.json().catch(() => ({}))) as RangeAddressRiskResponse;
      const riskScore = typeof payload.riskScore === "number" ? payload.riskScore : null;
      const riskLevel = typeof payload.riskLevel === "string" ? payload.riskLevel : undefined;

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
        message: error instanceof Error ? error.message : "Failed to call Range API",
        evaluatedAt,
      };
    }
  }
}
