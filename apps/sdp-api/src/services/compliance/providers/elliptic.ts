import { z } from "zod";
import type {
  ComplianceAddressScreeningInput,
  ComplianceProvider,
  ComplianceProviderResult,
} from "../types";
import { describeSchemaFailure, extractProviderErrorMessage } from "./provider-response";

const DEFAULT_ELLIPTIC_API_BASE_URL = "https://aml-api.elliptic.co";
const ELLIPTIC_SCREENING_PATH = "/v2/wallet/synchronous";

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
 * decision is exactly the ambiguity HOO-1012 closes.
 *
 * The schema states that at the boundary: the canonical score is required, so
 * a response without one fails to parse rather than being searched for a
 * substitute, and the string fields must be strings. Nested objects are left
 * untyped on purpose — nothing below the top level may inform the verdict.
 */
const ellipticWalletResponseSchema = z.object({
  risk_score: z.number().finite().nullable(),
  risk_level: z.string().min(1).optional(),
  process_status: z.string().min(1).optional(),
});

/**
 * Elliptic's own completion word for the synchronous wallet analysis. Compared
 * case-insensitively because the field is provider prose, not an SDP enum.
 */
const ELLIPTIC_COMPLETED_PROCESS_STATUSES = new Set(["complete", "completed"]);

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
        const body = extractProviderErrorMessage(await response.text().catch(() => ""));
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

      const body = await response.json().catch(() => undefined);
      if (body === undefined) {
        return {
          provider: this.name,
          status: "error",
          riskScore: null,
          message: "Elliptic returned a response that is not valid JSON.",
          evaluatedAt,
        };
      }

      const parsed = ellipticWalletResponseSchema.safeParse(body);
      if (!parsed.success) {
        return {
          provider: this.name,
          status: "error",
          riskScore: null,
          message: `Elliptic returned no readable top-level risk_score; refusing to interpret nested fields as the verdict (${describeSchemaFailure(parsed.error)}).`,
          evaluatedAt,
        };
      }

      const {
        risk_score: riskScore,
        risk_level: riskLevel,
        process_status: processStatus,
      } = parsed.data;

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
      const screened: ComplianceProviderResult = {
        provider: this.name,
        status: "ok",
        riskScore,
        evaluatedAt,
      };
      if (riskLevel !== undefined) {
        screened.riskLevel = riskLevel;
      }
      if (processStatus !== undefined) {
        screened.providerStatus = processStatus;
      }
      return screened;
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
