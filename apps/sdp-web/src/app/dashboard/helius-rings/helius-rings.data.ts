/**
 * Client seam for the Helius Rings workspace: fetches go through the
 * /api/dashboard/helius-rings BFF proxies, and the types mirror the API DTOs
 * without importing server packages.
 */

export type RingsHealthStatus = "green" | "amber" | "red";

/** Mirrors RUNTIME_HEALTH_COMPONENTS in @sdp/helius-rings, in the API's order. */
export const RINGS_HEALTH_COMPONENTS = ["rpc", "prover", "photon"] as const;
export type RingsHealthComponent = (typeof RINGS_HEALTH_COMPONENTS)[number];

export type RingsHealth = Record<RingsHealthComponent, RingsHealthStatus> & {
  /**
   * Keyed `<component>.reason` by the API. An absent entry means "no reason
   * given", never "healthy".
   */
  detail?: Record<string, string>;
};

export type RingsWalletStatus = "pending" | "ready" | "paused";

export interface RingsWallet {
  id: string;
  sdpWalletId: string;
  name: string;
  shieldedAddress: string | null;
  status: RingsWalletStatus;
  network: "devnet";
}

export type RingsOperationState =
  | "draft"
  | "preparing"
  | "approval_required"
  | "proving"
  | "ready_to_sign"
  | "submitted"
  | "indexing"
  | "completed"
  | "failed"
  | "voided";

/** Mirrors OP_TYPES in @sdp/helius-rings; literal so `activity.opType_*` resolves. */
export type RingsOperationOpType =
  | "shield"
  | "transfer_registered"
  | "transfer_anonymous"
  | "withdraw"
  | "merge"
  | "timelock_create"
  | "timelock_settle"
  | "zone_create";

export interface RingsOperationSummary {
  id: string;
  walletId: string;
  opType: RingsOperationOpType;
  state: RingsOperationState;
  assetMint: string | null;
  amountRaw: string | null;
  createdAt: string;
  failureCode: string | null;
  outerTxSignature: string | null;
  retryable: boolean | null;
  /** The operation this one was filed to replace, if it is a retry. */
  retryOfOperationId: string | null;
}

export interface RingsOperationEvent {
  kind: string;
  createdAt: string;
  /** Redacted server-side; free-form. Consumers must not trust individual keys. */
  payload?: Record<string, unknown> | null;
}

export interface RingsOperationDetail extends RingsOperationSummary {
  failure: { code: string; message: string; retryable: boolean } | null;
  events: RingsOperationEvent[];
}

interface Envelope<T> {
  data?: T;
  error?: { message?: string };
}

type EnvelopeResult<T> = { ok: true; data: T } | { ok: false; status: number; error?: string };

/**
 * The body is parsed even on failure so the server's own `error.message`
 * reaches the caller; `.catch` absorbs a non-JSON error page.
 */
async function readEnvelope<T>(response: Response): Promise<EnvelopeResult<T>> {
  const body = (await response.json().catch(() => ({}))) as Envelope<T>;
  if (!response.ok || !body.data) {
    return { ok: false, status: response.status, error: body.error?.message };
  }
  return { ok: true, data: body.data };
}

async function getJson<T>(path: string, fallbackError: string): Promise<T> {
  const response = await fetch(path, { cache: "no-store" });
  const result = await readEnvelope<T>(response);
  if (!result.ok) {
    throw new Error(result.error ?? fallbackError);
  }
  return result.data;
}

export function fetchRingsHealth(fallbackError: string): Promise<{ health: RingsHealth }> {
  return getJson("/api/dashboard/helius-rings/health", fallbackError);
}

export function fetchRingsWallets(fallbackError: string): Promise<{ wallets: RingsWallet[] }> {
  return getJson("/api/dashboard/helius-rings/wallets", fallbackError);
}

export function fetchRingsOperationDetail(
  operationId: string,
  fallbackError: string
): Promise<{ operation: RingsOperationDetail }> {
  return getJson(
    `/api/dashboard/helius-rings/operations/${encodeURIComponent(operationId)}`,
    fallbackError
  );
}

export function fetchRingsOperations(
  fallbackError: string
): Promise<{ operations: RingsOperationSummary[] }> {
  return getJson("/api/dashboard/helius-rings/operations", fallbackError);
}

export interface CreateRingsWalletResult {
  wallet?: RingsWallet;
  /**
   * The server's own reason, whatever the status was. A 503 names fixable
   * conditions too, so it must not be rewritten as "awaiting integration".
   */
  error?: string;
}

export async function createRingsWallet(input: {
  walletId: string;
  name: string;
}): Promise<CreateRingsWalletResult> {
  const response = await fetch("/api/dashboard/helius-rings/wallets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    cache: "no-store",
  });
  const result = await readEnvelope<{ wallet: RingsWallet }>(response);
  if (!result.ok) {
    return { error: result.error };
  }
  return { wallet: result.data.wallet };
}

export interface RingsShieldedBalance {
  mint: string;
  symbol: string;
  /**
   * uint64 base units as a decimal string. Never parse into a JavaScript
   * number: anything past 2^53 rounds silently.
   */
  amountRaw: string;
  /** The mint's scale, or null when the API knew of none. Null is not zero. */
  decimals: number | null;
  /** USD per whole unit, when pricing was reachable. */
  usdPrice?: number;
  /** amountRaw × usdPrice, rounded to 2dp; absent when the mint went unpriced. */
  usdValue?: number;
}

export interface RingsWalletSync {
  balances: RingsShieldedBalance[];
  /**
   * The indexer could not read everything it found, so `balances` is partial
   * and must not be presented as complete.
   */
  degraded: boolean;
  /** When the answer was true — not a position to resume from. */
  observedAt: string;
  /** Sum of priced balances, or null if pricing failed for every mint. */
  totalUsd?: number | null;
}

/**
 * Reads the wallet's shielded balances. Operator action only: a sync is a full
 * indexer scan and advances the wallet's recorded observation point.
 */
export async function syncRingsWallet(
  walletId: string
): Promise<{ sync?: RingsWalletSync; error?: string }> {
  const response = await fetch(
    `/api/dashboard/helius-rings/wallets/${encodeURIComponent(walletId)}/sync`,
    { method: "POST", cache: "no-store" }
  );
  const result = await readEnvelope<RingsWalletSync>(response);
  if (!result.ok) {
    return { error: result.error };
  }
  return { sync: result.data };
}

/** Mirrors RingsIdentityStatus in @sdp/helius-rings. */
export type RingsIdentityStatus = "unregistered" | "ours" | "foreign";

/** Mirrors RingsIdentityMismatch; literal so `identity.mismatch_*` resolves. */
export type RingsIdentityMismatch = "owner" | "nullifier_key" | "viewing_key";

export interface RingsWalletIdentity {
  status: RingsIdentityStatus;
  /** Canonical shielded address this deployment derives for the wallet. */
  derivedShieldedAddress: string;
  /** Canonical shielded address the registry publishes; null when unregistered. */
  publishedShieldedAddress: string | null;
  /** Which published half differs. Null unless `status` is `foreign`. */
  mismatch: RingsIdentityMismatch | null;
  /** What our own row records; null when provisioning never completed. */
  recordedShieldedAddress: string | null;
}

/**
 * Reads what the Rings registry publishes for a wallet's owner. Records
 * nothing, but still operator action only: it costs an RPC round trip and
 * derives key material server-side.
 */
export async function fetchRingsWalletIdentity(
  walletId: string
): Promise<{ identity?: RingsWalletIdentity; error?: string }> {
  const response = await fetch(
    `/api/dashboard/helius-rings/wallets/${encodeURIComponent(walletId)}/identity`,
    { cache: "no-store" }
  );
  const result = await readEnvelope<{ identity: RingsWalletIdentity }>(response);
  if (!result.ok) {
    return { error: result.error };
  }
  return { identity: result.data.identity };
}

/**
 * What the API accepts today. Narrower than `RingsOperationOpType`, which also
 * has to name the older kinds already recorded against this project. The API
 * rejects anything else on a strict schema, so widening this without widening
 * that one only moves the refusal later.
 */
export type RingsOpType = "shield" | "withdraw" | "transfer_registered";

export interface PrepareRingsOperationInput {
  walletId: string;
  opType: RingsOpType;
  asset: { mint: string; amountRaw: string };
  /** Withdrawals only: the public address the funds leave the pool for. */
  to?: string;
}

type OperationResult = { operation?: RingsOperationDetail; error?: string };

async function postOperation(
  path: string,
  body?: Record<string, unknown>
): Promise<OperationResult> {
  const response = await fetch(path, {
    method: "POST",
    ...(body !== undefined && {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    cache: "no-store",
  });
  const result = await readEnvelope<{ operation: RingsOperationDetail }>(response);
  if (!result.ok) return { error: result.error };
  return { operation: result.data.operation };
}

export function prepareRingsOperation(input: PrepareRingsOperationInput): Promise<OperationResult> {
  return postOperation("/api/dashboard/helius-rings/operations", {
    ...input,
    clientNonce: crypto.randomUUID(),
  });
}

/** The approval verdict is read server-side, so this carries no body. */
export function executeRingsOperation(operationId: string): Promise<OperationResult> {
  return postOperation(
    `/api/dashboard/helius-rings/operations/${encodeURIComponent(operationId)}/execute`
  );
}

export function retryRingsOperation(operationId: string): Promise<OperationResult> {
  return postOperation(
    `/api/dashboard/helius-rings/operations/${encodeURIComponent(operationId)}/retry`,
    { clientNonce: crypto.randomUUID() }
  );
}

export function voidRingsOperation(
  operationId: string,
  signature: string
): Promise<OperationResult> {
  return postOperation(
    `/api/dashboard/helius-rings/operations/${encodeURIComponent(operationId)}/void`,
    { signature }
  );
}

/** Devnet assets seeded in the rings allowlist. */
export const RINGS_ALLOWLISTED_ASSETS = [
  { mint: "So11111111111111111111111111111111111111112", symbol: "SOL", decimals: 9 },
  { mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", symbol: "USDC", decimals: 6 },
] as const;
