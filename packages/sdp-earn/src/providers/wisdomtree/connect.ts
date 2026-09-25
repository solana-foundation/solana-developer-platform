import { createHash } from "node:crypto";
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
 * Bearer-token cache, keyed by a SHA-256 digest of the complete credential
 * tuple so two environments — or any rotated credential field — can never
 * share a token, while plaintext secrets stay out of any future dump or log
 * of the map. Expiry keeps a safety margin; WisdomTree's `expires_in` is
 * treated as advisory and an expired-token 401 surfaces as a normal provider
 * error on the next call.
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
  // A digest, not the raw tuple: the map outlives any single call, and a dump
  // or log of it must never carry the plaintext credentials. This is a
  // cache-KEY equivalence digest, not password storage or verification — the
  // credential itself is re-sent over TLS to the token endpoint on every
  // grant — so a fast hash is the point; a slow KDF here would only tax the
  // request path without hardening anything the map already protects.
  // codeql[js/password-hashing]
  const cacheKey = createHash("sha256")
    .update(
      JSON.stringify([
        config.baseUrl,
        config.credentials.clientId,
        config.credentials.clientSecret,
        config.credentials.username,
        config.credentials.password,
      ])
    )
    .digest("hex");

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
    // Absent means absent — and DRF-style serializers routinely spell that
    // with null. Fail closed on a WRONG type, never on absence.
    const value = record[field];
    if (value !== undefined && value !== null && typeof value !== expectedType) {
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
    // Same rule as the product reader: null is absence, not a wrong type.
    const fieldValue = record[field];
    if (fieldValue !== undefined && fieldValue !== null && typeof fieldValue !== "string") {
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
  return listWisdomTreeSolanaWalletsForOrganization(ctx, guid);
}

async function listWisdomTreeSolanaWalletsForOrganization(
  ctx: EarnRuntimeContext,
  guid: string
): Promise<WisdomTreeWalletRecord[]> {
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
  return lanes.flatMap((lane) => {
    if (!Array.isArray(lane)) {
      throw providerUnavailable("WisdomTree returned a malformed Solana wallets lane");
    }
    return lane.map(readWisdomTreeWalletRecord);
  });
}

export interface WisdomTreeDepositEligibility {
  eligible: boolean;
  reason?: string;
}

/**
 * Deliberately shared by every valid-but-ineligible admission outcome. The
 * external-wallet build route can be called without authentication, so naming
 * whether the wallet is absent, pending, or approved-but-unentitled would turn
 * it into a public KYC/tradability oracle.
 */
export const WISDOMTREE_DEPOSIT_INELIGIBLE_REASON =
  "This WisdomTree deposit is unavailable for the selected wallet and fund.";

const wisdomTreeDepositIneligible = (): WisdomTreeDepositEligibility => ({
  eligible: false,
  reason: WISDOMTREE_DEPOSIT_INELIGIBLE_REASON,
});

/**
 * Is `address` registered and approved, AND is `exchangeCode` tradable for the
 * organization authenticated by this credential?
 *
 * This intentionally implements Connect's direct/omnibus credential model:
 * `/api/organizations/me` is the organization whose wallet registry and
 * organization-scoped product shelf SDP checks. A moderator credential needs
 * an explicit, durable SDP-organization -> Connect child-organization mapping;
 * none exists, so this code MUST NOT guess a child GUID or claim moderator
 * support.
 *
 * This is the API-side half of WisdomTree's admission model — the on-chain
 * half is the transfer hook, which would fail the settlement leg anyway.
 * Checking both dimensions here refuses the transfer before money moves.
 * Structurally malformed provider responses throw PROVIDER_UNAVAILABLE;
 * well-formed negative results all return the same non-enumerating reason.
 */
export async function checkWisdomTreeDepositEligibility(
  ctx: EarnRuntimeContext,
  input: { address: string; exchangeCode: string }
): Promise<WisdomTreeDepositEligibility> {
  // Resolve `/me` exactly once, then perform both admission reads using the
  // same runtime context and cached bearer token. The products endpoint is
  // scoped by that token; the wallets endpoint is scoped by the resolved GUID.
  // The reads are independent of each other, so they are issued in parallel:
  // one fewer provider round-trip on the money-in hot path.
  const guid = await getWisdomTreeOrganizationGuid(ctx);
  const [wallets, products] = await Promise.all([
    listWisdomTreeSolanaWalletsForOrganization(ctx, guid),
    listWisdomTreeProducts(ctx),
  ]);

  const address = input.address.trim();
  const match = wallets.find((wallet) => wallet.public_key?.trim() === address);
  const status = match?.status?.trim().toLowerCase() ?? "";
  const walletApproved = WISDOMTREE_APPROVED_WALLET_STATUSES.has(status);
  const productTradable = products.some(
    (product) => product.exchange_code?.trim() === input.exchangeCode && product.can_trade === true
  );

  if (!walletApproved || !productTradable) {
    return wisdomTreeDepositIneligible();
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

export interface WisdomTreePurchaseOrderCompletion {
  orderReference: string;
  completedAt: string | null;
}

/**
 * The order fields the completion correlation reads, one reader per field so
 * the UNVERIFIED wire fix is one edit (see the module header). Absent means
 * absent — a missing field can simply fail to match; a WRONG type is a
 * malformed feed and throws, the same rule every reader in this module applies.
 */
interface WisdomTreeOrderRecord {
  orderId: string | null;
  tradeType: string | null;
  status: string | null;
  walletAddress: string | null;
  fund: string | null;
  amount: string | null;
  completedAt: string | null;
}

function readWisdomTreeOrderRecord(value: unknown): WisdomTreeOrderRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw providerUnavailable("WisdomTree returned a malformed order entry");
  }
  const record = value as Record<string, unknown>;
  const stringField = (field: string): string | null => {
    const fieldValue = record[field];
    if (fieldValue === undefined || fieldValue === null) return null;
    if (typeof fieldValue !== "string") {
      throw providerUnavailable(`WisdomTree returned an order with an invalid ${field}`);
    }
    const trimmed = fieldValue.trim();
    return trimmed === "" ? null : trimmed;
  };
  return {
    // The order's own identity: "id" is DRF's default primary key name.
    orderId: stringField("id"),
    tradeType: stringField("trade_type"),
    status: stringField("status"),
    // The investor wallet that funded the order — same field name the
    // on-receipt-wallet route answers with.
    walletAddress: stringField("wallet_address"),
    fund: stringField("fund"),
    amount: stringField("amount"),
    completedAt: stringField("completed_at"),
  };
}

/**
 * The order statuses Connect reports for a completed purchase. Fail-closed on
 * purpose: the docs type `status` as an open string and never enumerate it
 * (same posture as the wallet-approval statuses), so anything not spelled here
 * reads as "still working" until measured against a live tenant.
 */
const WISDOMTREE_COMPLETED_ORDER_STATUSES: ReadonlySet<string> = new Set(["completed"]);

/** Unsigned decimal string, the shape every amount in this module compares. */
const DECIMAL_STRING = /^\d+(?:\.\d+)?$/;

/**
 * How far an order's completion may PREDATE the deposit's own record and still
 * correlate to it. The payment leg is broadcast only after SDP writes the
 * movement row, so a genuine order for that deposit completes after it —
 * the tolerance exists solely for a provider clock lagging SDP's when the
 * order completes within moments of the broadcast. An older purchase of the
 * same wallet, fund, and amount completes materially earlier, far outside it.
 */
const ORDER_CORRELATION_CLOCK_SKEW_MS = 10 * 60 * 1_000;

/**
 * Exact numeric equality of two unsigned decimal strings, with no float on the
 * money path: "10.00" and "10" are the same order, "0.10" and "0.1" too.
 * Scales both fractional halves to a common width and compares the integers.
 */
function sameDecimalAmount(left: string, right: string): boolean {
  const [leftUnits, leftFraction = ""] = left.split(".");
  const [rightUnits, rightFraction = ""] = right.split(".");
  const width = Math.max(leftFraction.length, rightFraction.length);
  const scaled = (units: string, fraction: string) => BigInt(units + fraction.padEnd(width, "0"));
  return scaled(leftUnits, leftFraction) === scaled(rightUnits, rightFraction);
}

/**
 * Has Connect completed a Purchase order that this deposit could have opened?
 *
 * Authenticated correlation, fail-closed. The provider's own order book — read
 * with SDP's credentials — must name ALL of: this wallet, a Purchase, this
 * fund, this amount, a completed status, a readable order identity, and a
 * completion instant that is not OLDER than this deposit's own record
 * (`movementCreatedAt`, less a small clock-skew tolerance), for the deposit's
 * settlement to be demonstrated. The temporal bound is what separates this
 * deposit's order from an older completed purchase of the same wallet, fund,
 * and amount: without it, a new deposit whose own order is still pending would
 * be settled by that older order, its claim would release, and a twin deposit
 * could double-broadcast. The identity bound completes the separation: an
 * order that cannot name itself cannot be shown to belong to THIS deposit
 * rather than an older twin's, and one the ledger has already accepted
 * (`excludedOrderReferences`) completed a DIFFERENT deposit — one order must
 * never settle two. Anything less (a miss, a pending order, a match that
 * cannot be bound in time — no readable `completed_at` — an order with no
 * readable identity, a malformed feed, an unconfigured credential) answers
 * null and the row stays open — never a guess that closes a claim on money
 * already committed.
 *
 * UNVERIFIED field names throughout (`trade_type`, `wallet_address`, `fund`,
 * `amount`, `status`, `completed_at`, `id`): each is a single reader above, so
 * measuring the live tenant is one edit.
 */
export async function readWisdomTreePurchaseOrderCompletion(
  ctx: EarnRuntimeContext,
  input: {
    owner: string;
    fundExchangeCode: string;
    amountRequested: string;
    movementCreatedAt: string;
    excludedOrderReferences: readonly string[];
  }
): Promise<WisdomTreePurchaseOrderCompletion | null> {
  const movementCreatedMs = Date.parse(input.movementCreatedAt);
  if (Number.isNaN(movementCreatedMs)) {
    // This deposit cannot be bound to any order in time: fail closed.
    return null;
  }
  const orders = await _listWisdomTreeOrders(ctx);
  for (const entry of orders) {
    const order = readWisdomTreeOrderRecord(entry);
    if (order.tradeType !== "Purchase") continue;
    // Same normalization rule as the wallet-approval statuses above: case and
    // padding are serialization, not semantics.
    if (
      order.status === null ||
      !WISDOMTREE_COMPLETED_ORDER_STATUSES.has(order.status.trim().toLowerCase())
    ) {
      continue;
    }
    // The identity binding: an order with no readable id cannot be shown to
    // belong to THIS deposit rather than an older twin purchase — and an
    // identity the ledger already accepted completed a different deposit.
    // Both stay open (null), retried on a later tick — never a guess that
    // releases a claim on committed money.
    if (order.orderId === null) continue;
    if (input.excludedOrderReferences.includes(order.orderId)) continue;
    if (order.walletAddress?.toLowerCase() !== input.owner.toLowerCase()) continue;
    if (order.fund?.toUpperCase() !== input.fundExchangeCode.toUpperCase()) continue;
    // Both sides are decimal strings in the settlement currency; a numeric
    // comparison, never a string one — "10.00" and "10" are the same order.
    if (
      order.amount === null ||
      !DECIMAL_STRING.test(order.amount) ||
      !DECIMAL_STRING.test(input.amountRequested) ||
      !sameDecimalAmount(order.amount, input.amountRequested)
    ) {
      continue;
    }
    // The temporal binding: an order with no readable completion instant
    // cannot be shown to belong to THIS deposit rather than an older twin
    // purchase, and one that demonstrably completed before the deposit's
    // record exists cannot be its order either. Both stay open (null), retried
    // on a later tick — never a guess that releases a claim on committed money.
    const completedMs = order.completedAt === null ? Number.NaN : Date.parse(order.completedAt);
    if (
      Number.isNaN(completedMs) ||
      completedMs < movementCreatedMs - ORDER_CORRELATION_CLOCK_SKEW_MS
    ) {
      continue;
    }
    return {
      orderReference: order.orderId,
      completedAt: order.completedAt,
    };
  }
  return null;
}
