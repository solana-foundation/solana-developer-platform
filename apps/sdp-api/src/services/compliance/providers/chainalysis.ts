import { z } from "zod";
import type {
  ComplianceAddressScreeningInput,
  ComplianceProvider,
  ComplianceProviderResult,
} from "../types";
import { describeSchemaFailure, extractProviderErrorMessage } from "./provider-response";

const DEFAULT_CHAINALYSIS_API_BASE_URL = "https://api.chainalysis.com";

/**
 * The response is parsed at the boundary, not narrowed field by field further
 * in. Every documented field is typed, and a field carrying the wrong type is
 * a response we refuse to interpret rather than quietly ignore — reading past
 * a malformed score is how an ambiguous screening turns into a verdict
 * (HOO-1012). Undocumented keys are ignored, so the product's own extra fields
 * never break a screening.
 */
const chainalysisRiskResponseSchema = z.object({
  risk: z.string().optional(),
  riskLevel: z.string().optional(),
  risk_score: z.number().finite().optional(),
  riskScore: z.number().finite().optional(),
  score: z.number().finite().optional(),
  status: z.string().optional(),
  message: z.string().optional(),
});

type ChainalysisRiskResponse = z.infer<typeof chainalysisRiskResponseSchema>;

export interface ChainalysisComplianceProviderConfig {
  apiKey?: string;
  baseUrl?: string;
}

function normalizeChainalysisApiBaseUrl(baseUrl: string | undefined): string {
  const value = (baseUrl ?? DEFAULT_CHAINALYSIS_API_BASE_URL).trim();
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

/**
 * The numeric score under whichever alias this deployment's Chainalysis
 * product spells it. Aliases are tolerated, ambiguity is not: two aliases
 * carrying DIFFERENT numbers is a response we cannot interpret, and guessing
 * between them would weaken a compliance decision — the caller fails closed.
 */
function readRiskScore(payload: ChainalysisRiskResponse): { score: number | null } | "ambiguous" {
  const candidates = [payload.riskScore, payload.risk_score, payload.score].filter(
    (value): value is number => value !== undefined
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
  return payload.riskLevel ?? payload.risk;
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
        const body = extractProviderErrorMessage(await response.text().catch(() => ""));
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

      const body = await response.json().catch(() => undefined);
      if (body === undefined) {
        return {
          provider: this.name,
          status: "error",
          riskScore: null,
          message: "Chainalysis returned a response that is not valid JSON.",
          evaluatedAt,
        };
      }

      const parsed = chainalysisRiskResponseSchema.safeParse(body);
      if (!parsed.success) {
        return {
          provider: this.name,
          status: "error",
          riskScore: null,
          message: `Chainalysis returned an unreadable screening (${describeSchemaFailure(parsed.error)}).`,
          evaluatedAt,
        };
      }

      const payload = parsed.data;
      const providerStatus = payload.status;

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
        const ambiguous: ComplianceProviderResult = {
          provider: this.name,
          status: "error",
          riskScore: null,
          message: "Chainalysis returned conflicting risk-score fields; refusing to guess.",
          evaluatedAt,
        };
        if (providerStatus !== undefined) {
          ambiguous.providerStatus = providerStatus;
        }
        return ambiguous;
      }

      // A completed screening with neither a score nor a level carries no
      // verdict at all — malformed, so fail closed rather than pass on it.
      if (read.score === null && riskLevel === undefined) {
        const verdictless: ComplianceProviderResult = {
          provider: this.name,
          status: "error",
          riskScore: null,
          message: "Chainalysis response carried no risk score or risk level.",
          evaluatedAt,
        };
        if (providerStatus !== undefined) {
          verdictless.providerStatus = providerStatus;
        }
        return verdictless;
      }

      const passed: ComplianceProviderResult = {
        provider: this.name,
        status: "ok",
        riskScore: read.score,
        evaluatedAt,
      };
      if (riskLevel !== undefined) {
        passed.riskLevel = riskLevel;
      }
      if (providerStatus !== undefined) {
        passed.providerStatus = providerStatus;
      }
      return passed;
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
