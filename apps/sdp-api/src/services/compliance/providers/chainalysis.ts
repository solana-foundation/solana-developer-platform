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

/**
 * The numeric score under whichever alias this deployment's Chainalysis
 * product spells it. Aliases are tolerated, ambiguity is not: two aliases
 * carrying DIFFERENT numbers is a response we cannot interpret, and guessing
 * between them would weaken a compliance decision — the caller fails closed.
 */
function readRiskScore(payload: ChainalysisRiskResponse): { score: number | null } | "ambiguous" {
  const candidates = [payload.riskScore, payload.risk_score, payload.score].filter(
    (value): value is number => typeof value === "number"
  );
  if (candidates.length === 0) {
    return { score: null };
  }
  if (new Set(candidates).size > 1) {
    return "ambiguous";
  }
  return { score: candidates[0] };
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

      const payload = (await response.json().catch(() => null)) as ChainalysisRiskResponse | null;
      if (payload === null) {
        return {
          provider: this.name,
          status: "error",
          riskScore: null,
          message: "Chainalysis returned a response that is not valid JSON.",
          evaluatedAt,
        };
      }

      const providerStatus = typeof payload.status === "string" ? payload.status : undefined;

      // A screening the provider itself calls unfinished is NOT a verdict.
      // Reporting it `ok` let an IN_PROGRESS response read as a pass; it is
      // `pending`, and the raw status travels along for audit (HOO-1012).
      if (providerStatus !== undefined && providerStatus !== "COMPLETE") {
        return {
          provider: this.name,
          status: "pending",
          riskScore: null,
          providerStatus,
          message: `Chainalysis screening is not complete (status: ${providerStatus}).`,
          evaluatedAt,
        };
      }

      const read = readRiskScore(payload);
      const riskLevel = readRiskLevel(payload);
      if (read === "ambiguous") {
        return {
          provider: this.name,
          status: "error",
          riskScore: null,
          ...(providerStatus !== undefined ? { providerStatus } : {}),
          message: "Chainalysis returned conflicting risk-score fields; refusing to guess.",
          evaluatedAt,
        };
      }

      // A completed screening with neither a score nor a level carries no
      // verdict at all — malformed, so fail closed rather than pass on it.
      if (read.score === null && !riskLevel) {
        return {
          provider: this.name,
          status: "error",
          riskScore: null,
          ...(providerStatus !== undefined ? { providerStatus } : {}),
          message: "Chainalysis response carried no risk score or risk level.",
          evaluatedAt,
        };
      }

      return {
        provider: this.name,
        status: "ok",
        riskScore: read.score,
        ...(riskLevel ? { riskLevel } : {}),
        ...(providerStatus !== undefined ? { providerStatus } : {}),
        evaluatedAt,
      };
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
