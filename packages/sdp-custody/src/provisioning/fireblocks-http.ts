import { importPKCS8, SignJWT } from "jose";
import { SigningError } from "#/signing";
import { parseJsonResponse, sha256Hex } from "./common";
import type { CustodyProvisioningRuntime } from "./runtime";

export class FireblocksApiError extends SigningError {
  constructor(
    readonly status: number,
    readonly providerCode?: number,
    readonly requestId?: string
  ) {
    super(
      `Fireblocks API request failed (HTTP ${status}${providerCode === undefined ? "" : `, code ${providerCode}`})`,
      [401, 403, 404].includes(status) ? "PROVIDER_CREDENTIAL_INVALID" : "PROVIDER_NOT_CONFIGURED"
    );
  }
}

interface FireblocksRequestParams {
  apiBaseUrl: string;
  apiKey: string;
  apiSecretPem: string;
  method: "GET" | "POST";
  uri: string;
  body?: unknown;
  allowStatuses?: number[];
  idempotencyKey?: string;
}

export async function fireblocksRequest<T>(
  runtime: CustodyProvisioningRuntime,
  params: FireblocksRequestParams
): Promise<T> {
  // Fireblocks limits Idempotency-Key to 40 characters. Hash the complete key
  // (including operation suffixes) so retries stay stable and steps stay distinct.
  // Preserve previously valid keys, including existing payment externalTxIds.
  const idempotencyKey =
    params.idempotencyKey && params.idempotencyKey.length > 40
      ? (await sha256Hex(runtime, params.idempotencyKey)).slice(0, 40)
      : params.idempotencyKey;
  const bodyStr = params.body ? JSON.stringify(params.body) : "";
  const token = await createFireblocksJwt(
    runtime,
    params.apiKey,
    params.apiSecretPem,
    params.uri,
    bodyStr
  );

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "X-API-Key": params.apiKey,
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  if (params.body) headers["Content-Type"] = "application/json";
  const response = await runtime.fetch(`${params.apiBaseUrl}${params.uri}`, {
    method: params.method,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers,
    body: params.body ? bodyStr : undefined,
  });

  if (!response.ok && !(params.allowStatuses ?? []).includes(response.status)) {
    // Keep diagnostic identifiers, never arbitrary provider text or response bodies.
    const error = await response.json().catch(() => null);
    const rawCode = error && typeof error === "object" && "code" in error ? error.code : undefined;
    const code =
      typeof rawCode === "number"
        ? rawCode
        : typeof rawCode === "string" && /^-?\d{1,10}$/.test(rawCode)
          ? Number(rawCode)
          : undefined;
    const requestId = response.headers.get("x-request-id");
    throw new FireblocksApiError(
      response.status,
      Number.isSafeInteger(code) ? code : undefined,
      requestId && /^[a-zA-Z0-9:_-]{1,128}$/.test(requestId) ? requestId : undefined
    );
  }

  return parseJsonResponse<T>(response);
}

async function createFireblocksJwt(
  runtime: CustodyProvisioningRuntime,
  apiKey: string,
  privateKeyPem: string,
  uri: string,
  body: string
): Promise<string> {
  const privateKey = await importPKCS8(privateKeyPem, "RS256");
  const bodyHash = await sha256Hex(runtime, body);
  const nonce = runtime.randomUUID();
  const now = Math.floor(runtime.now() / 1000);

  return new SignJWT({ bodyHash, nonce, uri })
    .setProtectedHeader({ alg: "RS256" })
    .setSubject(apiKey)
    .setIssuedAt(now)
    .setExpirationTime(now + 30)
    .sign(privateKey);
}
