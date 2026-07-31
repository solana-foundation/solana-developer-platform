// SPC auth service client.
//
// One transport (`authRequest`) backs the whole auth surface:
//  - Standalone `spcRegister` — used by the member-invite flow
//    (services/private-channels/members.ts); `spcLogin` exchanges credentials for a
//    JWT outside that flow.
//  - `createAuthClient(authBaseUrl)` — the JWT-gated wallet surface
//    (challenge/verify/delete), used by the wallet-verification write path.
// Both accept `SpcAuthClientOptions` (injectable `fetchImpl` for tests).
// Fetch-only, with no Node or database imports. Exposed via the
// `@sdp/private-channels/auth` subpath so callers can import it without pulling
// the whole barrel; it is also re-exported from the barrel (e.g. `members.ts`
// imports `spcRegister` from `@sdp/private-channels`).

import { badRequest, classifyAuthStatus, PrivateChannelError } from "./errors";
import { normalizeHttpBase } from "./url";

const DEFAULT_TIMEOUT_MS = 15_000;

export interface SpcRegisterInput {
  username: string;
  password: string;
}

export interface SpcRegisteredUser {
  id: string;
  username: string;
  role: "user" | "operator";
  createdAt: string;
}

export interface SpcLoginInput {
  username: string;
  password: string;
}

export interface SpcLoginResult {
  token: string;
}

/** `POST /auth/challenge-wallet` response — the exact message to sign + its nonce. */
export interface SpcWalletChallenge {
  /** The exact UTF-8 string the wallet must sign. */
  message: string;
  /** Single-use nonce (UUID), echoed back on verify. */
  nonce: string;
  expires_at: string;
}

/** `POST /auth/verify-wallet` response — the recorded verified wallet. */
export interface SpcVerifiedWallet {
  pubkey: string;
  created_at: string;
}

/** Body for `POST /auth/verify-wallet`. */
export interface VerifyWalletInput {
  /** Base58 wallet pubkey being verified. */
  pubkey: string;
  /** Nonce from the preceding challenge. */
  nonce: string;
  /** Base58 Ed25519 signature over the challenge message. */
  signature: string;
}

/** Transport options shared by the standalone functions and {@link createAuthClient}. */
export interface SpcAuthClientOptions {
  /** Injectable `fetch` (for tests); defaults to the global. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms; defaults to `DEFAULT_TIMEOUT_MS` (15s). */
  timeoutMs?: number;
}

/** Typed REST client for the SPC auth service's JWT-gated wallet surface (`:8903`). */
export interface SpcAuthClient {
  /** `POST /auth/login` — exchange credentials for a 24h JWT (401 on bad creds). */
  login(input: SpcLoginInput): Promise<SpcLoginResult>;
  /** `POST /auth/challenge-wallet` — issue a wallet-verification challenge (JWT). */
  challengeWallet(token: string): Promise<SpcWalletChallenge>;
  /** `POST /auth/verify-wallet` — record a signed wallet (JWT; 409 if already verified). */
  verifyWallet(token: string, input: VerifyWalletInput): Promise<SpcVerifiedWallet>;
  /** `DELETE /auth/wallets/{pubkey}` — unlink a wallet (JWT; 400 if not associated). */
  deleteWallet(token: string, pubkey: string): Promise<void>;
}

/** Pull a human-readable message from a parsed auth error body (`message` then `error`). */
function extractMessage(body: unknown): string | null {
  if (body && typeof body === "object") {
    const m = (body as Record<string, unknown>).message;
    if (typeof m === "string") return m;
    const e = (body as Record<string, unknown>).error;
    if (typeof e === "string") return e;
  }
  return null;
}

interface AuthRequestInit {
  method: string;
  token?: string;
  body?: unknown;
  expectNoContent?: boolean;
}

/**
 * Single transport for every auth call: validate the base URL, issue the
 * request with an optional bearer token + JSON body, and map the outcome to a
 * `PrivateChannelError` (network failure → `AUTH_UNAVAILABLE`; HTTP status →
 * `classifyAuthStatus`). A missing base URL surfaces as `BAD_REQUEST`.
 */
async function authRequest<T>(
  authBaseUrl: string,
  path: string,
  init: AuthRequestInit,
  options: SpcAuthClientOptions = {}
): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const normalized = normalizeHttpBase(authBaseUrl, "Auth URL");
  if ("error" in normalized) throw badRequest(normalized.error);

  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.token) headers.Authorization = `Bearer ${init.token}`;

  let response: Response;
  let raw: string;
  try {
    response = await fetchImpl(`${normalized.base}${path}`, {
      method: init.method,
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Read the body inside the try as well: a connection drop mid-read should map
    // to AUTH_UNAVAILABLE, not escape as a raw TypeError (which maps to a 500).
    raw = await response.text();
  } catch (error) {
    throw new PrivateChannelError(
      "AUTH_UNAVAILABLE",
      `Failed to reach the auth service at ${path}`,
      { cause: error instanceof Error ? error.message : String(error) }
    );
  }

  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : undefined;
  } catch {
    parsed = undefined;
  }

  if (!response.ok) {
    throw new PrivateChannelError(
      classifyAuthStatus(response.status),
      extractMessage(parsed) ?? `Auth request to ${path} failed (${response.status})`,
      { status: response.status }
    );
  }

  if (init.expectNoContent) return undefined as T;
  return parsed as T;
}

// POST /auth/register — creates an SPC user. Returns the SPC user id + username.
export async function spcRegister(
  authUrl: string,
  input: SpcRegisterInput,
  options?: SpcAuthClientOptions
): Promise<SpcRegisteredUser> {
  const raw = await authRequest<{ id: string; username: string; role: string; created_at: string }>(
    authUrl,
    "/auth/register",
    { method: "POST", body: input },
    options
  );
  return {
    id: raw.id,
    username: raw.username,
    role: raw.role === "operator" ? "operator" : "user",
    createdAt: raw.created_at,
  };
}

// POST /auth/login — exchanges username + password for a JWT.
export async function spcLogin(
  authUrl: string,
  input: SpcLoginInput,
  options?: SpcAuthClientOptions
): Promise<SpcLoginResult> {
  return authRequest<SpcLoginResult>(
    authUrl,
    "/auth/login",
    { method: "POST", body: input },
    options
  );
}

/**
 * Construct a typed {@link SpcAuthClient} for one instance's auth base URL (the
 * connected instance's `authUrl`, e.g. `http://auth.example:8903`). Requires a
 * non-empty base URL (calls throw `BAD_REQUEST` otherwise); each request maps
 * HTTP status → `PrivateChannelError` and enforces `timeoutMs`.
 */
export function createAuthClient(
  authBaseUrl: string,
  options: SpcAuthClientOptions = {}
): SpcAuthClient {
  return {
    login: (input) =>
      authRequest<SpcLoginResult>(
        authBaseUrl,
        "/auth/login",
        { method: "POST", body: input },
        options
      ),
    challengeWallet: (token) =>
      authRequest<SpcWalletChallenge>(
        authBaseUrl,
        "/auth/challenge-wallet",
        { method: "POST", token },
        options
      ),
    verifyWallet: (token, input) =>
      authRequest<SpcVerifiedWallet>(
        authBaseUrl,
        "/auth/verify-wallet",
        { method: "POST", token, body: input },
        options
      ),
    deleteWallet: (token, pubkey) =>
      authRequest<void>(
        authBaseUrl,
        `/auth/wallets/${encodeURIComponent(pubkey)}`,
        { method: "DELETE", token, expectNoContent: true },
        options
      ),
  };
}
