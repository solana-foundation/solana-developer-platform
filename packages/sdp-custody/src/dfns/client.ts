import { Buffer } from "node:buffer";
import * as crypto from "node:crypto";
import { summarizeUpstreamErrorBody } from "@sdp/redaction";
import { assertHttpsBaseUrl } from "../provisioning/common";
import { SigningError } from "../signing";

/**
 * Structural env slice consumed by the DFNS client factory. The API app passes
 * its full doppler-injected `Env`; only these fields are read here.
 */
export interface DfnsEnv {
  DFNS_AUTH_TOKEN?: string;
  DFNS_CREDENTIAL_ID?: string;
  DFNS_PRIVATE_KEY?: string;
  DFNS_API_BASE_URL?: string;
}

/**
 * Structural env slice consumed by the IBM Digital Asset Haven client factory.
 */
export interface IbmHavenEnv {
  IBM_HAVEN_AUTH_TOKEN?: string;
  IBM_HAVEN_CREDENTIAL_ID?: string;
  IBM_HAVEN_PRIVATE_KEY?: string;
  IBM_HAVEN_API_BASE_URL?: string;
}

export const DEFAULT_DFNS_API_BASE_URL = "https://api.dfns.io";
// IBM Digital Asset Haven is a white-label Dfns deployment fronted by IBM's host.
export const DEFAULT_IBM_HAVEN_API_BASE_URL = "https://api.digitalassets.ibm.com";
// Provider display labels interpolated into error messages so each white-label
// deployment self-identifies (a Haven credential failure must not read "DFNS").
export const DFNS_PROVIDER_LABEL = "DFNS";
export const IBM_HAVEN_PROVIDER_LABEL = "IBM Digital Asset Haven";
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
  /**
   * Attached (non-enumerable, never serialized) by the client that issued
   * this request: drops the hold on this request's user action token once the
   * signer has handled the request's result. The hold exists so a provider
   * echoing the token back cannot dodge vetting by outliving the retention
   * window while its signature is still pending.
   */
  releaseHeldUpstreamSecret?: () => void;
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
  /**
   * Credentials this client authenticates with (bearer token, credential id,
   * private key material, and every user action token it has minted in the
   * current retention window). A compromised provider can echo back exactly
   * what it was sent, and a short bare token carries no shape a filter could
   * recognize, so provider-controlled fragments are also vetted against these
   * values by exact match before they may surface in an error message. A
   * function, not a snapshot: per-request user action tokens are minted after
   * construction, and the failed-signature `reason` vetting must see the
   * token of the very request that produced the signature.
   */
  readonly getKnownUpstreamSecrets?: () => readonly string[];
}

interface DfnsClientContext {
  authToken: string;
  credentialId: string;
  privateKey: string;
  baseUrl: string;
  /** Provider display label for error messages ("DFNS" or the white-label name). */
  providerLabel: string;
  userAgent: string;
  /**
   * Every user action token this context has minted in the current retention
   * window, mapped to its mint time and hold count. Unpinned tokens age out
   * of the window; a token held by a signature request stays in the map
   * until that request's result is handled (or the hold cap expires it),
   * however long the request takes and however many newer requests are
   * minted meanwhile.
   */
  readonly heldUserActionTokens: Map<string, { mintedAt: number; pinCount: number }>;
  /** Last time expired unpinned tokens were swept, to keep mints O(1) amortized. */
  lastUserActionTokenSweepAt: number;
  /** Wall clock (injectable for tests): drives retention windows and sweeps. */
  readonly now: () => number;
}

interface DfnsRequestOptions {
  requireUserAction?: boolean;
  query?: Record<string, string | number | undefined>;
  /** Invoked as soon as this request's user action token has been minted. */
  onUserActionToken?: (userActionToken: string) => void;
}

interface DfnsRawResponse {
  status: number;
  rawBody: string;
  contentType: string | null;
}

interface DfnsSignatureResult {
  signature: Buffer;
}

const DFNS_USER_AGENT = "sdp-api-dfns/1.0";
const IBM_HAVEN_USER_AGENT = "sdp-api-ibm-haven/1.0";

// Response media types reported verbatim in error messages. Anything else
// collapses to "unrecognized": `Content-Type` is provider-controlled, and the
// same compact-credential discipline as the body summarizer applies before a
// header value reaches `contentType=<value>` in a persisted error message.
const KNOWN_RESPONSE_CONTENT_TYPES = new Set([
  "application/json",
  "application/octet-stream",
  "application/problem+json",
  "application/xml",
  "text/html",
  "text/plain",
  "text/xml",
]);

function describeDfnsContentType(contentType: string | null): string {
  if (!contentType) {
    return "unknown";
  }
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  return KNOWN_RESPONSE_CONTENT_TYPES.has(mediaType) ? mediaType : "unrecognized";
}

const DFNS_DEFAULT_HEADERS: Readonly<Record<string, string>> = {
  Accept: "application/json",
  "Content-Type": "application/json",
};

function createDfnsCredentialSignature(
  privateKeyPem: string,
  payload: Buffer,
  providerLabel: string = DFNS_PROVIDER_LABEL
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

  const attempts: Array<{
    algorithm: "sha256" | "none";
    digest: string | undefined;
  }> = [];
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
    `${providerLabel} local signature creation failed: ${failures.join(" | ") || "unknown signing error"}`,
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

/**
 * Every credential this client context holds, plus every user action token it
 * has minted in the current retention window (and the per-request one, if it
 * is still in flight). Fed to the upstream error summarizer so a controlled
 * provider echoing one of them back in an error `code` (or a failed-signature
 * `reason`) collapses to `unavailable` even when the value is short and
 * unprefix-shaped.
 */
function heldUpstreamSecrets(ctx: DfnsClientContext, userActionToken?: string): readonly string[] {
  return [
    ctx.authToken,
    ctx.credentialId,
    ctx.privateKey,
    ...ctx.heldUserActionTokens.keys(),
    userActionToken,
  ].filter((secret): secret is string => typeof secret === "string" && secret.length > 0);
}

// Every token minted in the last hour is held, so unpinned tokens outlive
// any plausible echo of a finished request; tokens pinned by an in-flight
// signature request are held until its result is handled regardless of age.
const USER_ACTION_TOKEN_RETENTION_MS = 3_600_000;
// Sweeps are throttled so a mint's cost is O(1) amortized instead of a scan
// over everything held.
const USER_ACTION_TOKEN_SWEEP_INTERVAL_MS = 60_000;
// A pin is meant to last exactly as long as the signature result takes to be
// handled. This cap bounds the hold for callers that never release (the
// signer always does): far beyond any realistic poll, it keeps a long-lived
// client from accumulating pins without end.
const MAX_USER_ACTION_TOKEN_HOLD_MS = 24 * 3_600_000;

function recordUserActionToken(ctx: DfnsClientContext, userActionToken: string): void {
  const now = ctx.now();
  if (now - ctx.lastUserActionTokenSweepAt >= USER_ACTION_TOKEN_SWEEP_INTERVAL_MS) {
    ctx.lastUserActionTokenSweepAt = now;
    for (const [token, entry] of ctx.heldUserActionTokens) {
      const expired = now - entry.mintedAt >= USER_ACTION_TOKEN_RETENTION_MS;
      const holdCapped = now - entry.mintedAt >= MAX_USER_ACTION_TOKEN_HOLD_MS;
      if (expired && (entry.pinCount === 0 || holdCapped)) {
        ctx.heldUserActionTokens.delete(token);
      }
    }
  }
  // A provider repeating a token value must not reset or duplicate an entry
  // that other signature flows may already hold pins on.
  if (!ctx.heldUserActionTokens.has(userActionToken)) {
    ctx.heldUserActionTokens.set(userActionToken, { mintedAt: now, pinCount: 0 });
  }
}

function pinUserActionToken(ctx: DfnsClientContext, userActionToken: string): void {
  const entry = ctx.heldUserActionTokens.get(userActionToken);
  if (entry) {
    entry.pinCount += 1;
  }
}

function unpinUserActionToken(ctx: DfnsClientContext, userActionToken: string | undefined): void {
  if (!userActionToken) {
    return;
  }
  const entry = ctx.heldUserActionTokens.get(userActionToken);
  if (entry) {
    entry.pinCount = Math.max(0, entry.pinCount - 1);
  }
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
    "User-Agent": ctx.userAgent,
    ...(userActionToken ? { "x-dfns-useraction": userActionToken } : {}),
  };
}

async function readDfnsResponse(response: Response): Promise<DfnsRawResponse> {
  return {
    status: response.status,
    rawBody: await response.text(),
    contentType: response.headers.get("content-type"),
  };
}

function toBase64Url(data: Uint8Array): string {
  return Buffer.from(data)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function resolveDfnsContext(
  env: DfnsEnv,
  options?: { apiBaseUrl?: string; now?: () => number }
): DfnsClientContext {
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
    baseUrl: assertHttpsBaseUrl(
      options?.apiBaseUrl ?? env.DFNS_API_BASE_URL ?? DEFAULT_DFNS_API_BASE_URL,
      "DFNS"
    ),
    providerLabel: DFNS_PROVIDER_LABEL,
    userAgent: DFNS_USER_AGENT,
    heldUserActionTokens: new Map(),
    lastUserActionTokenSweepAt: 0,
    now: options?.now ?? Date.now,
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
      `${ctx.providerLabel} API non-JSON response (${method} ${path}): status=${response.status} contentType=${describeDfnsContentType(response.contentType)}`,
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
  if (userActionToken) {
    // Recorded before the request goes out: any response to this request —
    // error body, redirect follow-up, or a later signature status — may echo
    // the token back, and every summarizer site vets against the held tokens.
    recordUserActionToken(ctx, userActionToken);
    options?.onUserActionToken?.(userActionToken);
  }
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
    return followDfnsRedirect(ctx, {
      method,
      normalizedPath,
      requestUrl: url,
      location,
      status: current.status,
      userActionToken,
    });
  }

  if (!response.ok) {
    throw new SigningError(
      `${ctx.providerLabel} API error (${method} ${normalizedPath}): status=${current.status} contentType=${describeDfnsContentType(current.contentType)} code=${summarizeUpstreamErrorBody(current.rawBody, current.status, heldUpstreamSecrets(ctx, userActionToken))}`,
      "NETWORK_ERROR"
    );
  }

  return current;
}

/**
 * Re-issue a redirected request without ever handing the DFNS bearer token to
 * another origin. Only POST calls redirected within the configured API origin
 * are followed (DFNS answers some writes with a 3xx to the created resource);
 * anything else fails closed.
 */
async function followDfnsRedirect(
  ctx: DfnsClientContext,
  redirect: {
    method: "GET" | "POST";
    normalizedPath: string;
    requestUrl: URL;
    location: string;
    status: number;
    userActionToken?: string;
  }
): Promise<DfnsRawResponse> {
  const { method, normalizedPath, requestUrl, location, status, userActionToken } = redirect;
  const target = resolveDfnsRedirectTarget(requestUrl, location);

  if (!target || target.origin !== requestUrl.origin) {
    throw new SigningError(
      `${ctx.providerLabel} API returned a cross-origin redirect (${method} ${normalizedPath}): status=${status} redirectOrigin=${target?.origin ?? "invalid"}; refusing to forward credentials`,
      "NETWORK_ERROR"
    );
  }

  if (method !== "POST") {
    throw new SigningError(
      `${ctx.providerLabel} API returned an unsupported redirect (${method} ${normalizedPath}): status=${status}`,
      "NETWORK_ERROR"
    );
  }

  const followResponse = await fetch(target, {
    method: "GET",
    headers: createDfnsRequestHeaders(ctx),
    redirect: "manual",
  });
  const follow = await readDfnsResponse(followResponse);
  if (followResponse.ok) {
    return follow;
  }

  throw new SigningError(
    `${ctx.providerLabel} API redirect follow-up failed (${method} ${normalizedPath}): status=${follow.status} code=${summarizeUpstreamErrorBody(follow.rawBody, follow.status, heldUpstreamSecrets(ctx, userActionToken))}`,
    "NETWORK_ERROR"
  );
}

function resolveDfnsRedirectTarget(requestUrl: URL, location: string): URL | null {
  try {
    return new URL(location, requestUrl);
  } catch {
    return null;
  }
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
    // Neither the configured credential id nor the account's allowed ids may
    // appear here: this message reaches API clients and logs.
    throw new SigningError(
      `${ctx.providerLabel} rejected the configured credential for user action signing (${allowedCredentialIds.length} credential(s) allowed on this account)`,
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
    const signedChallenge = createDfnsCredentialSignature(
      ctx.privateKey,
      clientDataBytes,
      ctx.providerLabel
    );
    signature = signedChallenge.signature;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SigningError(
      `${ctx.providerLabel} local signature creation failed: ${reason}. This usually indicates runtime crypto incompatibility with ${ctx.providerLabel} private key material.`,
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
      `${ctx.providerLabel} user action signing failed: missing userAction token`,
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

export function resolveDfnsNetwork(
  value?: string,
  providerLabel: string = DFNS_PROVIDER_LABEL
): DfnsNetwork {
  if (!value) {
    return DEFAULT_DFNS_NETWORK;
  }

  if (value === "Solana" || value === "SolanaDevnet") {
    return value;
  }

  throw new SigningError(
    `${providerLabel} network must be one of: Solana, SolanaDevnet`,
    "PROVIDER_NOT_CONFIGURED"
  );
}

function buildDfnsApiClient(ctx: DfnsClientContext): DfnsApiClient {
  return {
    getKnownUpstreamSecrets: () => heldUpstreamSecrets(ctx),
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
      createSignature: async (request: { keyId: string; body: DfnsCreateSignatureBody }) => {
        let userActionToken: string | undefined;
        let signatureRequest: DfnsSignatureRequest;
        try {
          signatureRequest = await dfnsRequestJson<DfnsSignatureRequest>(
            ctx,
            "POST",
            `/keys/${encodeURIComponent(request.keyId)}/signatures`,
            request.body,
            {
              onUserActionToken: (token) => {
                userActionToken = token;
                // Pinned the moment it exists: the create response may take
                // arbitrarily long (the fetch has no timeout), and a sweep
                // triggered by another request's mint must not evict the
                // token before its own response arrives.
                pinUserActionToken(ctx, token);
              },
            }
          );
        } catch (error) {
          // The create failed, so no signature result this token backs will
          // ever be handled and no release handle gets attached. Drop the pin
          // and let the token age out of the retention window normally.
          unpinUserActionToken(ctx, userActionToken);
          throw error;
        }
        if (userActionToken && signatureRequest && typeof signatureRequest === "object") {
          // The signer drops the pin through this handle once it has handled
          // the request's result; after that the token simply ages out of the
          // retention window.
          Object.defineProperty(signatureRequest, "releaseHeldUpstreamSecret", {
            value: () => unpinUserActionToken(ctx, userActionToken),
            enumerable: false,
          });
        } else {
          // An unusable response means no signature result can ever be
          // handled for this token; nothing needs the pin.
          unpinUserActionToken(ctx, userActionToken);
        }
        return signatureRequest;
      },
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

export async function createDfnsApiClient(
  env: DfnsEnv,
  options?: { apiBaseUrl?: string; now?: () => number }
): Promise<DfnsApiClient> {
  return buildDfnsApiClient(resolveDfnsContext(env, options));
}

// IBM Digital Asset Haven reuses the Dfns request/UAS/signing machinery with
// IBM-hosted credentials (IBM_HAVEN_*) and base URL — same wire protocol.
function resolveIbmHavenContext(
  env: IbmHavenEnv,
  options?: { apiBaseUrl?: string; now?: () => number }
): DfnsClientContext {
  const authToken = env.IBM_HAVEN_AUTH_TOKEN;
  const credentialId = env.IBM_HAVEN_CREDENTIAL_ID;
  const privateKey = env.IBM_HAVEN_PRIVATE_KEY
    ? normalizePrivateKey(env.IBM_HAVEN_PRIVATE_KEY)
    : undefined;

  if (!authToken || !credentialId || !privateKey) {
    throw new SigningError(
      "IBM Digital Asset Haven environment variables not configured: IBM_HAVEN_AUTH_TOKEN, IBM_HAVEN_CREDENTIAL_ID, IBM_HAVEN_PRIVATE_KEY",
      "PROVIDER_NOT_CONFIGURED"
    );
  }

  return {
    authToken,
    credentialId,
    privateKey,
    baseUrl: assertHttpsBaseUrl(
      options?.apiBaseUrl ?? env.IBM_HAVEN_API_BASE_URL ?? DEFAULT_IBM_HAVEN_API_BASE_URL,
      "IBM Digital Asset Haven"
    ),
    providerLabel: IBM_HAVEN_PROVIDER_LABEL,
    userAgent: IBM_HAVEN_USER_AGENT,
    heldUserActionTokens: new Map(),
    lastUserActionTokenSweepAt: 0,
    now: options?.now ?? Date.now,
  };
}

export async function createIbmHavenApiClient(
  env: IbmHavenEnv,
  options?: { apiBaseUrl?: string; now?: () => number }
): Promise<DfnsApiClient> {
  return buildDfnsApiClient(resolveIbmHavenContext(env, options));
}
