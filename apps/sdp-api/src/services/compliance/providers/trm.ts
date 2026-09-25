import { resolveComplianceVerdict } from "@sdp/types";
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

      let parsedBody: unknown;
      try {
        parsedBody = await response.json();
      } catch {
        parsedBody = null;
      }

      // An `ok` TRM body is an array with one screening result per submitted
      // address, so the shape is validated before a missing risk field can be
      // read as the documented no-attribution pass: invalid JSON, a non-array
      // body, an empty array, or a non-object entry used to normalize to "no
      // score, no label" and pass screening (SOLA9-160).
      const first =
        Array.isArray(parsedBody) &&
        typeof parsedBody[0] === "object" &&
        parsedBody[0] !== null &&
        !Array.isArray(parsedBody[0])
          ? (parsedBody[0] as TrmAddressScreeningResponse[number])
          : undefined;
      if (!first) {
        return {
          provider: this.name,
          status: "error",
          riskScore: null,
          message: `TRM returned a malformed screening response at ${TRM_ADDRESS_SCREENING_PATH} (expected a non-empty array of result objects); refusing to treat it as a screening.`,
          evaluatedAt,
        };
      }
      const riskScore =
        typeof first?.addressHighestRiskScoreLevel === "number"
          ? first.addressHighestRiskScoreLevel
          : null;
      const riskLevel =
        typeof first?.addressHighestRiskScoreLevelLabel === "string"
          ? first.addressHighestRiskScoreLevelLabel
          : undefined;

      // An `ok` result must carry a verdict this product recognizes: no score
      // plus a label outside the shared vocabulary is contract drift that used
      // to normalize as a clean screening (SOLA9-160). A null score with no
      // label stays TRM's documented no-attribution completion.
      const verdict = resolveComplianceVerdict({ provider: this.name, riskScore, riskLevel });
      if (verdict === "unrecognized") {
        return {
          provider: this.name,
          status: "error",
          riskScore: null,
          message: `TRM returned an unrecognized risk verdict (score: ${JSON.stringify(riskScore)}, level: ${JSON.stringify(riskLevel ?? null)}); refusing to treat it as a screening.`,
          evaluatedAt,
        };
      }

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
