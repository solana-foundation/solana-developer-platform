import type { EarnProviderId } from "@sdp/types/provider-access";
import { providerNotConfigured, providerUnavailable, SdpEarnError } from "../../errors";
import { providerFetchJson } from "../../fetch";
import type { EarnRuntimeContext } from "../../types";

/**
 * WisdomTree Connect REST client — the HTTP half of the integration, shared by
 * the catalogue client in this package and the instruction builders in
 * `@sdp/wisdomtree` (which depends on this package, never the reverse).
 *
 * Plain `providerFetchJson` over OAuth2, no chain SDK — this module rides the
 * hourly catalogue cron, so the @sdp/earn dependency rule (nothing heavier
 * than @sdp/types) binds it.
 *
 * ── Wire shapes are documented, not yet measured ────────────────────────────
 * Endpoint paths, parameter names and response fields below come from
 * WisdomTree's published OpenAPI spec and integration guides
 * (docs.wisdomtreeconnect.com, read 2026-08-28). SDP holds no Connect
 * credentials yet, so unlike Ground's client none of this is verified against
 * a live tenant — anything marked UNVERIFIED is the first thing to re-check
 * when credentials arrive, and each is a constant or a single reader so the
 * fix is one edit.
 */

const WISDOMTREE_PROVIDER: EarnProviderId = "wisdomtree";

const WISDOMTREE_PRODUCTION_API_URL = "https://app.wisdomtreeconnect.com";
const WISDOMTREE_SANDBOX_API_URL = "https://api.sandbox.wisdomtreeconnect.com";

/** Same sizing argument as Kamino's: both callers are deadline-bounded jobs or requests. */
const WISDOMTREE_REQUEST_TIMEOUT_MS = 10_000;

/**
 * The `blockchain` key WisdomTree's order routes take for Solana. UNVERIFIED:
 * their examples only ever show Ethereum values ("Ethereum", "Ethereum
 * Testnet Sepolia"); "Solana" matches the docs' chain-selector label. Confirm
 * against `GET /api/orders/order-mapping` with live credentials.
 */
export const WISDOMTREE_SOLANA_BLOCKCHAIN_KEY = "Solana";

/**
 * Wallet `status` values SDP accepts as deposit-eligible. Fail-closed on
 * purpose: the docs type the field as an open string and never enumerate it,
 * so anything not in this set reads as "not approved" until measured.
 */
const WISDOMTREE_APPROVED_WALLET_STATUSES: ReadonlySet<string> = new Set(["approved"]);

export interface WisdomTreeCredentials {
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
}

export interface WisdomTreeConfig {
  baseUrl: string;
  credentials: WisdomTreeCredentials;
}

const CREDENTIAL_FIELDS = ["clientId", "clientSecret", "username", "password"] as const;

/**
 * Parse the packed credential (see `EarnRuntimeEnvironment.WISDOMTREE_API_KEY`).
 * Missing OR malformed both throw PROVIDER_NOT_CONFIGURED before any network
 * call — a credential that cannot authenticate is not configured, whatever the
 * env var contains.
 */
export function readWisdomTreeConfig(ctx: EarnRuntimeContext): WisdomTreeConfig {
  const sandbox = ctx.environment !== "production";
  const raw = (sandbox ? ctx.env.WISDOMTREE_SANDBOX_API_KEY : ctx.env.WISDOMTREE_API_KEY)?.trim();
  const keyName = sandbox ? "WISDOMTREE_SANDBOX_API_KEY" : "WISDOMTREE_API_KEY";
  if (!raw) {
    throw providerNotConfigured(
      sandbox
        ? "WisdomTree sandbox is not configured. Set WISDOMTREE_SANDBOX_API_KEY."
        : "WisdomTree is not configured. Set WISDOMTREE_API_KEY."
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw providerNotConfigured(
      `${keyName} is not valid JSON. Expected {"clientId","clientSecret","username","password"}.`
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw providerNotConfigured(
      `${keyName} must be a JSON object with {"clientId","clientSecret","username","password"}.`
    );
  }
  const record = parsed as Partial<Record<(typeof CREDENTIAL_FIELDS)[number], unknown>>;
  for (const field of CREDENTIAL_FIELDS) {
    const value = record[field];
    if (typeof value !== "string" || value.trim() === "") {
      throw providerNotConfigured(`${keyName} is missing the "${field}" field.`);
    }
  }

  return {
    baseUrl: sandbox ? WISDOMTREE_SANDBOX_API_URL : WISDOMTREE_PRODUCTION_API_URL,
    credentials: {
      clientId: (record.clientId as string).trim(),
      clientSecret: (record.clientSecret as string).trim(),
      username: (record.username as string).trim(),
      password: (record.password as string).trim(),
    },
  };
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

/**
 * Bearer-token cache, keyed by the complete credential tuple so two
 * environments — or any rotated credential field — can never share a token. Expiry
 * keeps a safety margin; WisdomTree's `expires_in` is treated as advisory and
 * an expired-token 401 surfaces as a normal provider error on the next call.
 */
const tokenCache = new Map<string, CachedToken>();

/** Test seam: forget cached bearer tokens. */
export function resetWisdomTreeTokenCache(): void {
  tokenCache.clear();
}

const TOKEN_EXPIRY_MARGIN_MS = 60_000;
const TOKEN_MINIMUM_TTL_MS = 30_000;
const TOKEN_DEFAULT_TTL_SECONDS = 300;

interface WisdomTreeTokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
}

/** OAuth2 password grant at `POST /o/token/` — the one authentication path Connect documents. */
async function getWisdomTreeAccessToken(
  ctx: EarnRuntimeContext
): Promise<{ token: string; baseUrl: string; cacheKey: string }> {
  const config = readWisdomTreeConfig(ctx);
  const cacheKey = JSON.stringify([
    config.baseUrl,
    config.credentials.clientId,
    config.credentials.clientSecret,
    config.credentials.username,
    config.credentials.password,
  ]);

  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAtMs > Date.now()) {
    return { token: cached.token, baseUrl: config.baseUrl, cacheKey };
  }

  const basic = Buffer.from(
    `${config.credentials.clientId}:${config.credentials.clientSecret}`
  ).toString("base64");
  const body = new URLSearchParams({
    grant_type: "password",
    username: config.credentials.username,
    password: config.credentials.password,
    scope: "read write",
  });
  const response = await providerFetchJson<WisdomTreeTokenResponse, URLSearchParams>(
    WISDOMTREE_PROVIDER,
    `${config.baseUrl}/o/token/`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        // providerFetch defaults to JSON; the token route is the one
        // form-encoded call Connect takes.
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      timeoutMs: WISDOMTREE_REQUEST_TIMEOUT_MS,
    }
  );

  const token = typeof response.access_token === "string" ? response.access_token.trim() : "";
  if (!token) {
    throw providerUnavailable("WisdomTree token endpoint returned no access_token");
  }
  const ttlSeconds =
    typeof response.expires_in === "number" && Number.isFinite(response.expires_in)
      ? response.expires_in
      : TOKEN_DEFAULT_TTL_SECONDS;
  const ttlMs = Math.max(TOKEN_MINIMUM_TTL_MS, ttlSeconds * 1000 - TOKEN_EXPIRY_MARGIN_MS);
  tokenCache.set(cacheKey, { token, expiresAtMs: Date.now() + ttlMs });

  return { token, baseUrl: config.baseUrl, cacheKey };
}

async function connectGetJson<TResponse>(
  ctx: EarnRuntimeContext,
  path: string,
  params?: Record<string, string>
): Promise<TResponse> {
  let access = await getWisdomTreeAccessToken(ctx);
  // Connect's docs are emphatic about canonical trailing-slash routes; every
  // path constant in this module already carries the shape its spec states.
  const url = new URL(path, access.baseUrl);
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, value);
  }
  const request = (token: string) =>
    providerFetchJson<TResponse>(WISDOMTREE_PROVIDER, url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      timeoutMs: WISDOMTREE_REQUEST_TIMEOUT_MS,
    });
  try {
    return await request(access.token);
  } catch (error) {
    if (!(error instanceof SdpEarnError) || error.details?.providerStatus !== 401) {
      throw error;
    }
    // A token may be revoked before its advertised expiry. Forget it, perform
    // one fresh grant, and retry exactly once; a second 401 is the final error.
    tokenCache.delete(access.cacheKey);
    access = await getWisdomTreeAccessToken(ctx);
    return request(access.token);
  }
}

export interface WisdomTreeProduct {
  id?: number;
  name?: string;
  exchange_code?: string;
  issuer?: string;
  can_trade?: boolean;
}

function readWisdomTreeProduct(value: unknown): WisdomTreeProduct {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw providerUnavailable("WisdomTree returned a malformed product entry");
  }
  const record = value as Record<string, unknown>;
  const fields = [
    ["id", "number"],
    ["name", "string"],
    ["exchange_code", "string"],
    ["issuer", "string"],
    ["can_trade", "boolean"],
  ] as const;
  for (const [field, expectedType] of fields) {
    if (record[field] !== undefined && typeof record[field] !== expectedType) {
      throw providerUnavailable(`WisdomTree returned a product with an invalid ${field}`);
    }
  }
  return record as WisdomTreeProduct;
}

/**
 * The products available to the authenticated organization. ALL-OR-NOTHING:
 * a 200 with no `products` array is malformed, not empty — the catalogue sync
 * deletes rows a provider no longer lists, so a mis-read here would delist the
 * shelf rather than degrade (same rule as Kamino's metrics pages).
 */
export async function listWisdomTreeProducts(
  ctx: EarnRuntimeContext
): Promise<WisdomTreeProduct[]> {
  const response = await connectGetJson<{ products?: unknown }>(ctx, "/api/orders/products");
  if (!Array.isArray(response.products)) {
    throw providerUnavailable("WisdomTree returned a products response with no products array");
  }
  return response.products.map(readWisdomTreeProduct);
}

export type WisdomTreeTradeType = "Purchase" | "Sale";

/**
 * The standing WisdomTree-operated wallet that receives the on-chain leg of a
 * transfer-triggered order: USDC sent to it opens a Purchase; fund tokens sent
 * to it open a Sale. Resolved per (trade type, fund, currency) at build time —
 * never cached across builds, because a stale settlement address is money sent
 * to the wrong place.
 */
export async function getWisdomTreeOnReceiptWallet(
  ctx: EarnRuntimeContext,
  input: { tradeType: WisdomTreeTradeType; fund: string; currency: string }
): Promise<string> {
  const response = await connectGetJson<{ wallet_address?: unknown }>(
    ctx,
    "/api/orders/on-receipt-wallet/",
    {
      trade_type: input.tradeType,
      blockchain: WISDOMTREE_SOLANA_BLOCKCHAIN_KEY,
      currency: input.currency,
      fund: input.fund,
    }
  );
  const wallet = typeof response.wallet_address === "string" ? response.wallet_address.trim() : "";
  if (!wallet) {
    throw providerUnavailable(
      `WisdomTree returned no on-receipt ${input.tradeType} wallet for ${input.fund} on Solana`
    );
  }
  return wallet;
}

interface WisdomTreeOrganizationResponse {
  guid?: unknown;
  organisation_guid?: unknown;
  organization_guid?: unknown;
}

/**
 * The authenticated organization's GUID — the path key for wallet reads.
 * UNVERIFIED field name: the docs show `/api/organizations/me` returning the
 * organization detail but never print the field; all three spellings Connect
 * uses elsewhere are accepted.
 */
export async function getWisdomTreeOrganizationGuid(ctx: EarnRuntimeContext): Promise<string> {
  const response = await connectGetJson<WisdomTreeOrganizationResponse>(
    ctx,
    "/api/organizations/me"
  );
  for (const candidate of [response.guid, response.organisation_guid, response.organization_guid]) {
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return candidate.trim();
    }
  }
  throw providerUnavailable("WisdomTree returned an organization response with no guid");
}

export interface WisdomTreeWalletRecord {
  wallet_guid?: string;
  public_key?: string;
  status?: string;
}

function readWisdomTreeWalletRecord(value: unknown): WisdomTreeWalletRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw providerUnavailable("WisdomTree returned a malformed wallet entry");
  }
  const record = value as Record<string, unknown>;
  for (const field of ["wallet_guid", "public_key", "status"] as const) {
    if (record[field] !== undefined && typeof record[field] !== "string") {
      throw providerUnavailable(`WisdomTree returned a wallet with an invalid ${field}`);
    }
  }
  return record as WisdomTreeWalletRecord;
}

/**
 * The organization's registered Solana wallets. The response keys its `data`
 * map by blockchain name; matched case-insensitively on "solana" so a label
 * change ("Solana" vs "solana_mainnet") degrades to a re-read, not to every
 * wallet reading as unregistered... which it would anyway: an ABSENT Solana
 * lane answers [] here, and eligibility fails closed on it.
 */
export async function listWisdomTreeSolanaWallets(
  ctx: EarnRuntimeContext
): Promise<WisdomTreeWalletRecord[]> {
  const guid = await getWisdomTreeOrganizationGuid(ctx);
  const response = await connectGetJson<{ data?: unknown }>(
    ctx,
    `/api/organizations/${guid}/wallets`
  );
  const data = response.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw providerUnavailable("WisdomTree returned a wallets response with no data map");
  }
  const lanes = Object.entries(data as Record<string, unknown>)
    .filter(([blockchain]) => blockchain.toLowerCase().includes("solana"))
    .map(([, wallets]) => wallets);
  return lanes.flatMap((lane) => (Array.isArray(lane) ? lane.map(readWisdomTreeWalletRecord) : []));
}

export interface WisdomTreeWalletEligibility {
  eligible: boolean;
  reason?: string;
}

/**
 * Is `address` registered AND approved with WisdomTree Connect?
 *
 * This is the API-side half of WisdomTree's KYC model — the on-chain half is
 * the transfer hook, which would fail the settlement leg anyway. Checking here
 * turns "your deposit landed at WisdomTree and nothing came back" into a
 * refusal the caller can act on BEFORE money moves. Fail-closed throughout:
 * unregistered, unapproved and unknown-status wallets are all ineligible.
 */
export async function checkWisdomTreeWalletEligibility(
  ctx: EarnRuntimeContext,
  address: string
): Promise<WisdomTreeWalletEligibility> {
  const wallets = await listWisdomTreeSolanaWallets(ctx);
  const match = wallets.find((wallet) => wallet.public_key?.trim() === address);
  if (!match) {
    return {
      eligible: false,
      reason:
        "This wallet is not registered with WisdomTree Connect. Fund tokens can only settle " +
        "to a wallet WisdomTree has verified (KYC) and approved.",
    };
  }
  const status = match.status?.trim().toLowerCase() ?? "";
  if (!WISDOMTREE_APPROVED_WALLET_STATUSES.has(status)) {
    return {
      eligible: false,
      reason: `This wallet is registered with WisdomTree Connect but its status is "${
        match.status ?? "unknown"
      }", not approved.`,
    };
  }
  return { eligible: true };
}

/**
 * Raw orders feed — tooling surface (underscore convention, like Ground's
 * `_iterateYieldSources`): consumed by inventory/settlement tooling and the
 * future order-settlement reconciler, not part of the provider contract.
 * Accepts both the bare-array and wrapped shapes because the spec never prints
 * this route's envelope. UNVERIFIED.
 */
export async function _listWisdomTreeOrders(ctx: EarnRuntimeContext): Promise<unknown[]> {
  const response = await connectGetJson<unknown>(ctx, "/api/orders/all");
  if (Array.isArray(response)) return response;
  if (response && typeof response === "object") {
    const wrapped = (response as { orders?: unknown }).orders;
    if (Array.isArray(wrapped)) return wrapped;
  }
  throw providerUnavailable("WisdomTree returned an orders response in an unrecognized shape");
}
