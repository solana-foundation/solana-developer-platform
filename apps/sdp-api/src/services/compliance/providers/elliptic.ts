import type {
  ComplianceAddressScreeningInput,
  ComplianceProvider,
  ComplianceProviderResult,
} from "../types";

const DEFAULT_ELLIPTIC_API_BASE_URL = "https://aml-api.elliptic.co";
const ELLIPTIC_SCREENING_PATH = "/v2/wallet/synchronous";

type EllipticAddressScreeningResponse = Record<string, unknown>;

export interface EllipticComplianceProviderConfig {
  apiToken?: string;
  apiKey?: string;
  apiSecret?: string;
  baseUrl?: string;
}

function normalizeEllipticApiBaseUrl(baseUrl: string | undefined): string {
  const value = (baseUrl ?? DEFAULT_ELLIPTIC_API_BASE_URL).trim();
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

function isNotInBlockchainResponse(responseStatus: number, body: string): boolean {
  if (responseStatus !== 404) {
    return false;
  }

  return (
    body.includes("NotInBlockchain") ||
    body.includes("has not yet been processed into the Elliptic tool") ||
    body.includes("does not exist on the blockchain")
  );
}

function decodeBase64(value: string): Uint8Array {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("ELLIPTIC_API_SECRET is empty.");
  }

  try {
    const binary = atob(trimmed);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    throw new Error("ELLIPTIC_API_SECRET must be valid base64.");
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

async function createSignature(input: {
  apiSecretBase64: string;
  timestamp: string;
  method: string;
  path: string;
  payload: string;
}): Promise<string> {
  const secretBytes = decodeBase64(input.apiSecretBase64);
  const signingKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(secretBytes),
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["sign"]
  );
  const content = `${input.timestamp}${input.method.toUpperCase()}${input.path.toLowerCase()}${input.payload}`;
  const signature = await crypto.subtle.sign("HMAC", signingKey, new TextEncoder().encode(content));
  return encodeBase64(new Uint8Array(signature));
}

/**
 * The canonical Elliptic verdict is the TOP-LEVEL `risk_score` of the
 * synchronous wallet analysis — documented as nullable (null means no risk
 * rules triggered). The old deep search took the first `risk_score` found
 * ANYWHERE in the response, which could be a per-rule or per-exposure entry
 * rather than the wallet's own verdict; a nested contribution read as the
 * decision is exactly the ambiguity HOO-1012 closes. Anything but a number or
 * an explicit null at the top level is unreadable — the caller fails closed.
 */
function readCanonicalRiskScore(
  payload: Record<string, unknown>
): { score: number | null } | "unreadable" {
  if (!("risk_score" in payload)) {
    return "unreadable";
  }
  const value = payload.risk_score;
  if (value === null) {
    return { score: null };
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return { score: value };
  }
  return "unreadable";
}

/**
 * Elliptic's own completion word for the synchronous wallet analysis. Compared
 * case-insensitively because the field is provider prose, not an SDP enum.
 */
const ELLIPTIC_COMPLETED_PROCESS_STATUSES = new Set(["complete", "completed"]);

/** Top level only, same reasoning as the score: never a nested rule's word. */
function readCanonicalStringField(
  payload: Record<string, unknown>,
  field: string
): string | undefined {
  const value = payload[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export class EllipticComplianceProvider implements ComplianceProvider {
  readonly name = "elliptic" as const;

  constructor(private readonly config: EllipticComplianceProviderConfig) {}

  private buildPayload(input: ComplianceAddressScreeningInput): string {
    return JSON.stringify({
      subject: {
        asset: "holistic",
        blockchain: "holistic",
        type: "address",
        hash: input.address,
      },
      type: "wallet_exposure",
      customer_reference: `${input.network}:${input.intent}`,
    });
  }

  async screenAddress(input: ComplianceAddressScreeningInput): Promise<ComplianceProviderResult> {
    const evaluatedAt = new Date().toISOString();
    const apiToken = this.config.apiToken?.trim();
    const apiKey = this.config.apiKey?.trim();
    const apiSecret = this.config.apiSecret?.trim();

    if (!apiToken && (!apiKey || !apiSecret)) {
      return {
        provider: this.name,
        status: "unavailable",
        riskScore: null,
        message: "ELLIPTIC_API_TOKEN or ELLIPTIC_API_KEY plus ELLIPTIC_API_SECRET are required.",
        evaluatedAt,
      };
    }

    const baseUrl = normalizeEllipticApiBaseUrl(this.config.baseUrl);
    const url = new URL(ELLIPTIC_SCREENING_PATH, baseUrl);
    const payload = this.buildPayload(input);

    try {
      const response = apiToken
        ? await fetch(url.toString(), {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiToken}`,
              "Content-Type": "application/json",
            },
            body: payload,
          })
        : await (async () => {
            const timestamp = Date.now().toString();
            const signature = await createSignature({
              apiSecretBase64: apiSecret as string,
              timestamp,
              method: "POST",
              path: ELLIPTIC_SCREENING_PATH,
              payload,
            });

            return fetch(url.toString(), {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-access-key": apiKey as string,
                "x-access-sign": signature,
                "x-access-timestamp": timestamp,
              },
              body: payload,
            });
          })();

      if (!response.ok) {
        const body = extractErrorMessage(await response.text().catch(() => ""));
        if (isNotInBlockchainResponse(response.status, body)) {
          return {
            provider: this.name,
            status: "ok",
            riskScore: null,
            riskLevel: "Check passed",
            evaluatedAt,
          };
        }

        return {
          provider: this.name,
          status: "error",
          riskScore: null,
          message: body
            ? `Elliptic request failed (${response.status}): ${body}`
            : `Elliptic request failed (${response.status})`,
          evaluatedAt,
        };
      }

      const result = (await response
        .json()
        .catch(() => null)) as EllipticAddressScreeningResponse | null;
      if (result === null || typeof result !== "object" || Array.isArray(result)) {
        return {
          provider: this.name,
          status: "error",
          riskScore: null,
          message: "Elliptic returned a response that is not a JSON object.",
          evaluatedAt,
        };
      }

      const read = readCanonicalRiskScore(result);
      if (read === "unreadable") {
        return {
          provider: this.name,
          status: "error",
          riskScore: null,
          message:
            "Elliptic response carried no readable top-level risk_score; refusing to interpret nested fields as the verdict.",
          evaluatedAt,
        };
      }

      const riskLevel = readCanonicalStringField(result, "risk_level");
      const processStatus = readCanonicalStringField(result, "process_status");

      // A screening Elliptic itself calls unfinished is NOT a verdict, exactly
      // as with Chainalysis: a readable score alongside a non-final
      // process_status was still reporting `ok`, so an in-progress analysis
      // read as a pass. The field is absent on most responses, and absence
      // stays a completed verdict — only a stated non-final status holds
      // (HOO-1012).
      if (
        processStatus !== undefined &&
        !ELLIPTIC_COMPLETED_PROCESS_STATUSES.has(processStatus.toLowerCase())
      ) {
        return {
          provider: this.name,
          status: "pending",
          riskScore: null,
          providerStatus: processStatus,
          message: `Elliptic screening is not complete (process_status: ${processStatus}).`,
          evaluatedAt,
        };
      }

      // A null canonical score is Elliptic's documented "no risk rules
      // triggered" — a completed verdict, not an absence of one.
      return {
        provider: this.name,
        status: "ok",
        riskScore: read.score,
        ...(riskLevel ? { riskLevel } : {}),
        ...(processStatus ? { providerStatus: processStatus } : {}),
        evaluatedAt,
      };
    } catch (error) {
      return {
        provider: this.name,
        status: "error",
        riskScore: null,
        message: error instanceof Error ? error.message : "Failed to call Elliptic API",
        evaluatedAt,
      };
    }
  }
}
