import type {
  ComplianceAddressScreeningInput,
  ComplianceProvider,
  ComplianceProviderResult,
} from "../types";

const DEFAULT_CHAINALYSIS_API_BASE_URL = "https://api.chainalysis.com";

type ChainalysisRiskResponse = {
  risk?: unknown;
  riskLevel?: unknown;
  risk_score?: unknown;
  riskScore?: unknown;
  score?: unknown;
  status?: unknown;
  message?: unknown;
};

export interface ChainalysisComplianceProviderConfig {
  apiKey?: string;
  baseUrl?: string;
}

function normalizeChainalysisApiBaseUrl(baseUrl: string | undefined): string {
  const value = (baseUrl ?? DEFAULT_CHAINALYSIS_API_BASE_URL).trim();
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

function readRiskScore(payload: ChainalysisRiskResponse): number | null {
  if (typeof payload.riskScore === "number") {
    return payload.riskScore;
  }
  if (typeof payload.risk_score === "number") {
    return payload.risk_score;
  }
  if (typeof payload.score === "number") {
    return payload.score;
  }
  return null;
}

function readRiskLevel(payload: ChainalysisRiskResponse): string | undefined {
  if (typeof payload.riskLevel === "string") {
    return payload.riskLevel;
  }
  if (typeof payload.risk === "string") {
    return payload.risk;
  }
  return undefined;
}

export class ChainalysisComplianceProvider implements ComplianceProvider {
  readonly name = "chainalysis" as const;

  constructor(private readonly config: ChainalysisComplianceProviderConfig) {}

  async screenAddress(input: ComplianceAddressScreeningInput): Promise<ComplianceProviderResult> {
    const evaluatedAt = new Date().toISOString();
    const apiKey = this.config.apiKey?.trim();

    if (!apiKey) {
      return {
        provider: this.name,
        status: "unavailable",
        riskScore: null,
        message: "CHAINALYSIS_API_KEY is not configured.",
        evaluatedAt,
      };
    }

    const baseUrl = normalizeChainalysisApiBaseUrl(this.config.baseUrl);
    const url = new URL(`/api/risk/v2/entities/${encodeURIComponent(input.address)}`, baseUrl);

    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          Token: apiKey,
        },
      });

      if (!response.ok) {
        const body = extractErrorMessage(await response.text().catch(() => ""));
        return {
          provider: this.name,
          status: "error",
          riskScore: null,
          message: body
            ? `Chainalysis request failed (${response.status}): ${body}`
            : `Chainalysis request failed (${response.status})`,
          evaluatedAt,
        };
      }

      const payload = (await response.json().catch(() => ({}))) as ChainalysisRiskResponse;
      const riskScore = readRiskScore(payload);
      const riskLevel = readRiskLevel(payload);
      const result: ComplianceProviderResult = {
        provider: this.name,
        status: "ok",
        riskScore,
        evaluatedAt,
      };

      if (riskLevel) {
        result.riskLevel = riskLevel;
      }

      if (typeof payload.status === "string" && payload.status !== "COMPLETE") {
        result.message = `Chainalysis screening status: ${payload.status}`;
      }

      return result;
    } catch (error) {
      return {
        provider: this.name,
        status: "error",
        riskScore: null,
        message: error instanceof Error ? error.message : "Failed to call Chainalysis API",
        evaluatedAt,
      };
    }
  }
}
