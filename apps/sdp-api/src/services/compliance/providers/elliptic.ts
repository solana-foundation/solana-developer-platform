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
    secretBytes,
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

function findNumericField(payload: unknown, field: string): number | null {
  if (Array.isArray(payload)) {
    for (const entry of payload) {
      const nested = findNumericField(entry, field);
      if (nested !== null) {
        return nested;
      }
    }
    return null;
  }
  if (!payload || typeof payload !== "object") {
    return null;
  }

  for (const [key, value] of Object.entries(payload)) {
    if (key === field && typeof value === "number") {
      return value;
    }
    const nested = findNumericField(value, field);
    if (nested !== null) {
      return nested;
    }
  }

  return null;
}

function findStringField(payload: unknown, field: string): string | undefined {
  if (Array.isArray(payload)) {
    for (const entry of payload) {
      const nested = findStringField(entry, field);
      if (nested) {
        return nested;
      }
    }
    return undefined;
  }
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  for (const [key, value] of Object.entries(payload)) {
    if (key === field && typeof value === "string") {
      return value;
    }
    const nested = findStringField(value, field);
    if (nested) {
      return nested;
    }
  }

  return undefined;
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

      const result = (await response.json().catch(() => ({}))) as EllipticAddressScreeningResponse;
      const riskScore = findNumericField(result, "risk_score");
      const riskLevel = findStringField(result, "risk_level");

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
        message: error instanceof Error ? error.message : "Failed to call Elliptic API",
        evaluatedAt,
      };
    }
  }
}
