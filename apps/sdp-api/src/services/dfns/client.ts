import { Buffer } from "node:buffer";
import * as crypto from "node:crypto";
import { SigningError } from "@/services/ports";
import type { Env } from "@/types/env";

export const DEFAULT_DFNS_API_BASE_URL = "https://api.dfns.io";
export const DEFAULT_DFNS_NETWORK = "SolanaDevnet";

export type DfnsNetwork = "Solana" | "SolanaDevnet";

export interface DfnsWallet {
  id?: string;
  network?: string;
  address?: string;
  signingKey?: {
    id?: string;
  };
  dateCreated?: string;
  name?: string;
}

interface DfnsListWalletsQuery {
  limit?: number;
  paginationToken?: string;
  owner?: string;
  ownerId?: string;
  ownerUsername?: string;
}

interface DfnsListWalletsResponse {
  items: DfnsWallet[];
  nextPageToken?: string;
}

interface DfnsCreateWalletBody {
  network: string;
  name?: string;
  signingKey?: {
    id: string;
  };
}

export type DfnsSignatureStatus =
  | "Pending"
  | "Executing"
  | "Signed"
  | "Confirmed"
  | "Failed"
  | "Rejected";

interface DfnsSignatureShape {
  r?: string;
  s?: string;
  recid?: number;
  encoded?: string;
}

interface DfnsCreateSignatureBodyBase {
  blockchainKind?: "Solana";
  network?: string;
  externalId?: string;
}

interface DfnsCreateMessageSignatureBody extends DfnsCreateSignatureBodyBase {
  kind: "Message";
  message: string;
}

interface DfnsCreateTransactionSignatureBody extends DfnsCreateSignatureBodyBase {
  kind: "Transaction";
  transaction: string;
}

export type DfnsCreateSignatureBody =
  | DfnsCreateMessageSignatureBody
  | DfnsCreateTransactionSignatureBody;

export interface DfnsSignatureRequest {
  id?: string;
  keyId?: string;
  status?: DfnsSignatureStatus;
  reason?: string;
  signature?: DfnsSignatureShape;
  signatures?: DfnsSignatureShape[];
  signedData?: string;
  network?: string;
  dateRequested?: string;
  datePolicyResolved?: string;
  dateSigned?: string;
  dateConfirmed?: string;
}

interface DfnsUserActionChallenge {
  challenge: string;
  challengeIdentifier: string;
  allowCredentials?: {
    key?: Array<{
      id?: string;
    }>;
  };
}

interface DfnsUserActionResponse {
  userAction?: string;
}

export interface DfnsApiClient {
  wallets: {
    getWallet: (request: { walletId: string }) => Promise<DfnsWallet>;
    listWallets: (request?: { query?: DfnsListWalletsQuery }) => Promise<DfnsListWalletsResponse>;
    createWallet: (request: { body: DfnsCreateWalletBody }) => Promise<DfnsWallet>;
  };
  keySignatures: {
    createSignature: (request: {
      keyId: string;
      body: DfnsCreateSignatureBody;
    }) => Promise<DfnsSignatureRequest>;
    getSignature: (request: {
      keyId: string;
      signatureId: string;
    }) => Promise<DfnsSignatureRequest>;
  };
}

interface DfnsClientContext {
  authToken: string;
  credentialId: string;
  privateKey: string;
  baseUrl: string;
}

interface DfnsRequestOptions {
  requireUserAction?: boolean;
  query?: Record<string, string | number | undefined>;
}

interface DfnsRawResponse {
  status: number;
  rawBody: string;
  contentType: string | null;
  url: string;
}

interface DfnsSignatureResult {
  signature: Buffer;
}

const DFNS_USER_AGENT = "sdp-api-dfns/1.0";

const DFNS_DEFAULT_HEADERS: Readonly<Record<string, string>> = {
  Accept: "application/json",
  "Content-Type": "application/json",
  "User-Agent": DFNS_USER_AGENT,
};

function createDfnsCredentialSignature(
  privateKeyPem: string,
  payload: Buffer
): DfnsSignatureResult {
  let signingKey: crypto.KeyLike = privateKeyPem;
  let keyType: string | undefined;

  try {
    const parsed = crypto.createPrivateKey(privateKeyPem);
    signingKey = parsed;
    keyType = parsed.asymmetricKeyType;
  } catch {
    // If parsing fails, fall back to using the PEM directly.
  }

  const attempts: Array<{ algorithm: "sha256" | "none"; digest: string | undefined }> = [];
  if (keyType === "rsa" || keyType === "rsa-pss") {
    attempts.push(
      { algorithm: "sha256", digest: "sha256" },
      { algorithm: "none", digest: undefined }
    );
  } else if (keyType === "ed25519" || keyType === "ed448") {
    attempts.push(
      { algorithm: "none", digest: undefined },
      { algorithm: "sha256", digest: "sha256" }
    );
  } else {
    attempts.push(
      { algorithm: "none", digest: undefined },
      { algorithm: "sha256", digest: "sha256" }
    );
  }

  const failures: string[] = [];
  for (const attempt of attempts) {
    try {
      const signature = crypto.sign(attempt.digest, payload, signingKey);
      return {
        signature,
      };
    } catch (error) {
      failures.push(
        `${attempt.algorithm}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  throw new SigningError(
    `DFNS local signature creation failed: ${failures.join(" | ") || "unknown signing error"}`,
    "NETWORK_ERROR"
  );
}

function normalizePrivateKey(raw: string): string {
  const trimmed = raw.trim();
  const unquoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
      ? trimmed.slice(1, -1)
      : trimmed;
  return unquoted.replace(/\\n/g, "\n");
}

function truncateForError(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= 200 ? collapsed : `${collapsed.slice(0, 200)}...`;
}

function parseJsonSafely(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeDfnsPath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function applyDfnsQueryParams(url: URL, query?: Record<string, string | number | undefined>): void {
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
}

function createDfnsRequestHeaders(
  ctx: DfnsClientContext,
  userActionToken?: string
): Record<string, string> {
  return {
    Authorization: `Bearer ${ctx.authToken}`,
    ...DFNS_DEFAULT_HEADERS,
    ...(userActionToken ? { "x-dfns-useraction": userActionToken } : {}),
  };
}

async function readDfnsResponse(response: Response): Promise<DfnsRawResponse> {
  return {
    status: response.status,
    rawBody: await response.text(),
    contentType: response.headers.get("content-type"),
    url: response.url,
  };
}

function toBase64Url(data: Uint8Array): string {
  return Buffer.from(data)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function resolveDfnsContext(env: Env, options?: { apiBaseUrl?: string }): DfnsClientContext {
  const authToken = env.DFNS_AUTH_TOKEN;
  const credentialId = env.DFNS_CREDENTIAL_ID;
  const privateKey = env.DFNS_PRIVATE_KEY ? normalizePrivateKey(env.DFNS_PRIVATE_KEY) : undefined;

  if (!authToken || !credentialId || !privateKey) {
    throw new SigningError(
      "DFNS environment variables not configured: DFNS_AUTH_TOKEN, DFNS_CREDENTIAL_ID, DFNS_PRIVATE_KEY",
      "PROVIDER_NOT_CONFIGURED"
    );
  }

  return {
    authToken,
    credentialId,
    privateKey,
    baseUrl: options?.apiBaseUrl ?? env.DFNS_API_BASE_URL ?? DEFAULT_DFNS_API_BASE_URL,
  };
}

async function dfnsRequestJson<T>(
  ctx: DfnsClientContext,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  options?: DfnsRequestOptions
): Promise<T> {
  const response = await dfnsRequestRaw(ctx, method, path, body, options);
  const rawBody = response.rawBody;

  if (!rawBody) {
    return undefined as T;
  }

  const parsed = parseJsonSafely(rawBody);
  if (!parsed) {
    throw new SigningError(
      `DFNS API non-JSON response (${method} ${path}): status=${response.status} contentType=${response.contentType ?? "unknown"} url=${response.url} body=${truncateForError(rawBody)}`,
      "NETWORK_ERROR"
    );
  }

  return parsed as T;
}

async function dfnsRequestRaw(
  ctx: DfnsClientContext,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  options?: DfnsRequestOptions
): Promise<DfnsRawResponse> {
  const normalizedPath = normalizeDfnsPath(path);
  const url = new URL(normalizedPath, ctx.baseUrl);
  applyDfnsQueryParams(url, options?.query);

  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  const requireUserAction = options?.requireUserAction ?? method !== "GET";
  const userActionToken =
    requireUserAction && method !== "GET"
      ? await createDfnsUserActionToken(ctx, method, normalizedPath, payload ?? "")
      : undefined;
  const headers = createDfnsRequestHeaders(ctx, userActionToken);
  const response = await fetch(url, {
    method,
    headers,
    body: payload,
    redirect: "manual",
  });
  const current = await readDfnsResponse(response);
  const location = response.headers.get("location");

  if (response.status >= 300 && response.status < 400 && location) {
    const followUrl = new URL(location, url).toString();
    if (method === "POST") {
      const followResponse = await fetch(followUrl, {
        method: "GET",
        headers: createDfnsRequestHeaders(ctx),
        redirect: "manual",
      });
      const follow = await readDfnsResponse(followResponse);
      if (followResponse.ok) {
        return follow;
      }

      throw new SigningError(
        `DFNS API redirect follow-up failed (${method} ${normalizedPath} -> ${followUrl}): ${follow.status} ${truncateForError(follow.rawBody)}`,
        "NETWORK_ERROR"
      );
    }
  }

  if (!response.ok) {
    throw new SigningError(
      `DFNS API error (${method} ${normalizedPath}): status=${current.status} contentType=${current.contentType ?? "unknown"} location=${location ?? "none"} url=${current.url} body=${truncateForError(current.rawBody)}`,
      "NETWORK_ERROR"
    );
  }

  return current;
}

async function createDfnsUserActionToken(
  ctx: DfnsClientContext,
  method: "GET" | "POST",
  path: string,
  payload: string
): Promise<string> {
  const challenge = await dfnsRequestJson<DfnsUserActionChallenge>(
    ctx,
    "POST",
    "/auth/action/init",
    {
      userActionPayload: payload,
      userActionHttpMethod: method,
      userActionHttpPath: path,
      userActionServerKind: "Api",
    },
    { requireUserAction: false }
  );

  const allowedCredentialIds = (challenge.allowCredentials?.key ?? [])
    .map((item) => item.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  if (!allowedCredentialIds.includes(ctx.credentialId)) {
    throw new SigningError(
      `DFNS credential '${ctx.credentialId}' is not allowed. Allowed: ${allowedCredentialIds.join(", ") || "none"}`,
      "PROVIDER_NOT_CONFIGURED"
    );
  }

  const clientDataBytes = Buffer.from(
    JSON.stringify({
      type: "key.get",
      challenge: challenge.challenge,
    })
  );
  let signature: Buffer;
  try {
    const signedChallenge = createDfnsCredentialSignature(ctx.privateKey, clientDataBytes);
    signature = signedChallenge.signature;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SigningError(
      `DFNS local signature creation failed: ${reason}. This usually indicates runtime crypto incompatibility with DFNS private key material.`,
      "NETWORK_ERROR",
      error instanceof Error ? error : undefined
    );
  }

  const signed = await dfnsRequestJson<DfnsUserActionResponse>(
    ctx,
    "POST",
    "/auth/action",
    {
      challengeIdentifier: challenge.challengeIdentifier,
      firstFactor: {
        kind: "Key",
        credentialAssertion: {
          credId: ctx.credentialId,
          clientData: toBase64Url(clientDataBytes),
          signature: toBase64Url(signature),
        },
      },
    },
    { requireUserAction: false }
  );

  if (!signed.userAction) {
    throw new SigningError(
      "DFNS user action signing failed: missing userAction token",
      "NETWORK_ERROR"
    );
  }

  return signed.userAction;
}

export function normalizeDfnsWalletId(walletId: string): string {
  return walletId.startsWith("dfns_") ? walletId : `dfns_${walletId}`;
}

export function denormalizeDfnsWalletId(walletId: string): string {
  return walletId.startsWith("dfns_") ? walletId.slice("dfns_".length) : walletId;
}

export function resolveDfnsNetwork(value?: string): DfnsNetwork {
  if (!value) {
    return DEFAULT_DFNS_NETWORK;
  }

  if (value === "Solana" || value === "SolanaDevnet") {
    return value;
  }

  throw new SigningError(
    "DFNS network must be one of: Solana, SolanaDevnet",
    "PROVIDER_NOT_CONFIGURED"
  );
}

export async function createDfnsApiClient(
  env: Env,
  options?: { apiBaseUrl?: string }
): Promise<DfnsApiClient> {
  const ctx = resolveDfnsContext(env, options);

  return {
    wallets: {
      getWallet: async (request: { walletId: string }) =>
        dfnsRequestJson<DfnsWallet>(ctx, "GET", `/wallets/${encodeURIComponent(request.walletId)}`),
      listWallets: async (request?: { query?: DfnsListWalletsQuery }) =>
        dfnsRequestJson<DfnsListWalletsResponse>(ctx, "GET", "/wallets", undefined, {
          query: request?.query
            ? {
                limit: request.query.limit,
                paginationToken: request.query.paginationToken,
                owner: request.query.owner,
                ownerId: request.query.ownerId,
                ownerUsername: request.query.ownerUsername,
              }
            : undefined,
          requireUserAction: false,
        }),
      createWallet: async (request: { body: DfnsCreateWalletBody }) =>
        dfnsRequestJson<DfnsWallet>(ctx, "POST", "/wallets", request.body),
    },
    keySignatures: {
      createSignature: async (request: { keyId: string; body: DfnsCreateSignatureBody }) =>
        dfnsRequestJson<DfnsSignatureRequest>(
          ctx,
          "POST",
          `/keys/${encodeURIComponent(request.keyId)}/signatures`,
          request.body
        ),
      getSignature: async (request: { keyId: string; signatureId: string }) =>
        dfnsRequestJson<DfnsSignatureRequest>(
          ctx,
          "GET",
          `/keys/${encodeURIComponent(request.keyId)}/signatures/${encodeURIComponent(
            request.signatureId
          )}`
        ),
    },
  };
}
