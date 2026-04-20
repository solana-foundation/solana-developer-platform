import { importJWK, importPKCS8, SignJWT } from "jose";
import { SigningError } from "@/services/ports";
import type { Env } from "@/types/env";
import {
  decodeBase64ToBytes,
  encodePkcs8Pem,
  parseJsonResponse,
  randomHex,
  readErrorResponseText,
  sha256Hex,
  sortJsonKeys,
  toBase64Url,
} from "./provisioning.common";

export interface CoinbaseCdpRequestParams {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  apiBaseUrl: string;
  apiKeyId: string;
  apiKeySecret: string;
  walletSecret: string;
  idempotencyKey?: string;
  body?: Record<string, unknown>;
}

interface CoinbaseCdpBearerJwtParams {
  apiKeyId: string;
  apiKeySecret: string;
  requestMethod: string;
  requestHost: string;
  requestPath: string;
}

interface CoinbaseCdpWalletJwtParams {
  walletSecret: string;
  requestMethod: string;
  requestHost: string;
  requestPath: string;
  requestData: Record<string, unknown>;
}

export async function coinbaseCdpRequest<T>(params: CoinbaseCdpRequestParams): Promise<T> {
  const { requestPath, url } = resolveCoinbaseCdpRequestUrl(params.apiBaseUrl, params.path);
  const normalizedBody = params.body ? sortJsonKeys(params.body) : undefined;
  const bodyJson = normalizedBody ? JSON.stringify(normalizedBody) : undefined;

  try {
    const bearerToken = await createCoinbaseCdpBearerJwt({
      apiKeyId: params.apiKeyId,
      apiKeySecret: params.apiKeySecret,
      requestMethod: params.method,
      requestHost: url.host,
      requestPath,
    });

    const headers: Record<string, string> = {
      Authorization: `Bearer ${bearerToken}`,
      ...(bodyJson ? { "Content-Type": "application/json" } : {}),
      ...(params.idempotencyKey ? { "X-Idempotency-Key": params.idempotencyKey } : {}),
    };

    if (requiresCoinbaseCdpWalletAuth(params.method, requestPath)) {
      const walletAuthToken = await createCoinbaseCdpWalletJwt({
        walletSecret: params.walletSecret,
        requestMethod: params.method,
        requestHost: url.host,
        requestPath,
        requestData: (normalizedBody ?? {}) as Record<string, unknown>,
      });
      headers["X-Wallet-Auth"] = walletAuthToken;
    }

    const response = await fetch(url.toString(), {
      method: params.method,
      headers,
      body: bodyJson,
    });

    if (!response.ok) {
      const errorText = await readErrorResponseText(response);
      throw new SigningError(
        `Coinbase CDP API error: ${response.status} - ${errorText}`,
        "PROVIDER_NOT_CONFIGURED"
      );
    }

    return parseJsonResponse<T>(response);
  } catch (error) {
    if (error instanceof SigningError) {
      throw error;
    }

    throw new SigningError(
      `Failed to call Coinbase CDP API: ${error instanceof Error ? error.message : "Unknown error"}`,
      "NETWORK_ERROR",
      error instanceof Error ? error : undefined
    );
  }
}

function resolveCoinbaseCdpRequestUrl(
  apiBaseUrl: string,
  path: string
): { requestPath: string; url: URL } {
  const normalizedBaseUrl = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
  const url = new URL(normalizedPath, normalizedBaseUrl);

  return {
    requestPath: `${url.pathname}${url.search}`,
    url,
  };
}

async function createCoinbaseCdpBearerJwt(params: CoinbaseCdpBearerJwtParams): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const nonce = randomHex(16);
  const uri = `${params.requestMethod} ${params.requestHost}${params.requestPath}`;

  const payload = new SignJWT({ uris: [uri] })
    .setIssuer("cdp")
    .setSubject(params.apiKeyId)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + 120);

  if (isPemEncodedKey(params.apiKeySecret)) {
    const key = await importPKCS8(params.apiKeySecret, "ES256");
    return payload.setProtectedHeader({ alg: "ES256", kid: params.apiKeyId, nonce }).sign(key);
  }

  const rawKey = decodeBase64ToBytes(params.apiKeySecret);
  if (rawKey.length !== 64) {
    throw new SigningError(
      "COINBASE_CDP_API_KEY_SECRET has an invalid format. Expected EC PEM or base64 Ed25519 private key (64 bytes).",
      "PROVIDER_NOT_CONFIGURED"
    );
  }

  const seed = rawKey.slice(0, 32);
  const publicKey = rawKey.slice(32);
  const ed25519Jwk = {
    crv: "Ed25519",
    d: toBase64Url(seed),
    kty: "OKP",
    x: toBase64Url(publicKey),
  };

  const key = await importJWK(ed25519Jwk, "EdDSA");
  return payload.setProtectedHeader({ alg: "EdDSA", kid: params.apiKeyId, nonce }).sign(key);
}

async function createCoinbaseCdpWalletJwt(params: CoinbaseCdpWalletJwtParams): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const uri = `${params.requestMethod} ${params.requestHost}${params.requestPath}`;
  const payload: Record<string, unknown> = { uris: [uri] };

  const shouldIncludeReqHash =
    Object.keys(params.requestData).length > 0 &&
    Object.values(params.requestData).some((value) => value !== undefined);

  if (shouldIncludeReqHash) {
    payload.reqHash = await sha256Hex(JSON.stringify(sortJsonKeys(params.requestData)));
  }

  const pkcs8DerBytes = decodeBase64ToBytes(params.walletSecret);
  const privateKeyPem = encodePkcs8Pem(pkcs8DerBytes);
  const key = await importPKCS8(privateKeyPem, "ES256");

  return new SignJWT(payload)
    .setProtectedHeader({ alg: "ES256", typ: "JWT" })
    .setIssuedAt(now)
    .setNotBefore(now)
    .setJti(randomHex(16))
    .sign(key);
}

function requiresCoinbaseCdpWalletAuth(method: string, requestPath: string): boolean {
  if (!["POST", "PUT", "DELETE"].includes(method.toUpperCase())) {
    return false;
  }

  return requestPath.includes("/accounts") || requestPath.includes("/spend-permissions");
}

export function buildCoinbaseCdpAccountName(value: string, scope?: string): string {
  let normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!normalized) {
    normalized = "org";
  }

  const normalizedScope = scope
    ? scope
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "")
    : "";

  let name = `${normalizedScope ? `sdp-${normalizedScope}` : "sdp"}-${normalized}`.slice(0, 36);
  name = name.replace(/-+$/g, "");

  if (!/^[a-z0-9]/.test(name)) {
    name = `s${name}`;
  }

  if (!/[a-z0-9]$/.test(name)) {
    name = `${name}0`;
  }

  if (name.length < 2) {
    name = `sdp-${randomHex(2)}`.slice(0, 36);
  }

  return name;
}

export function resolveCoinbaseCdpAccountScope(env: Env): string {
  const explicitNamespace = env.COINBASE_CDP_ACCOUNT_NAMESPACE?.trim();
  return explicitNamespace || env.ENVIRONMENT;
}

export function extractCoinbaseCdpAccountAddress(response: unknown): string | null {
  if (!response || typeof response !== "object") {
    return null;
  }

  const record = response as Record<string, unknown>;
  const directAddress = record.address;
  if (typeof directAddress === "string" && directAddress.length > 0) {
    return directAddress;
  }

  const account = record.account;
  if (account && typeof account === "object") {
    const accountAddress = (account as Record<string, unknown>).address;
    if (typeof accountAddress === "string" && accountAddress.length > 0) {
      return accountAddress;
    }
  }

  const data = record.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const dataAddress = (data as Record<string, unknown>).address;
    if (typeof dataAddress === "string" && dataAddress.length > 0) {
      return dataAddress;
    }
  }

  if (Array.isArray(data)) {
    for (const entry of data) {
      if (!entry || typeof entry !== "object") {
        continue;
      }

      const entryAddress = (entry as Record<string, unknown>).address;
      if (typeof entryAddress === "string" && entryAddress.length > 0) {
        return entryAddress;
      }
    }
  }

  return null;
}

export function isCoinbaseCdpAlreadyExistsError(error: unknown): error is SigningError {
  if (!(error instanceof SigningError)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("coinbase cdp api error: 409") &&
    (message.includes("already_exists") || message.includes("already exists"))
  );
}

function isPemEncodedKey(value: string): boolean {
  return value.includes("-----BEGIN");
}
