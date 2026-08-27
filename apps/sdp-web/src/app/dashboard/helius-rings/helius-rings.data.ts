/**
 * Client seam for the Helius Rings workspace. Fetches go through the
 * /api/dashboard/helius-rings BFF proxies; view-model types mirror the API
 * DTOs without importing server packages.
 */

export type RingsHealthStatus = "green" | "amber" | "red";

/** Mirrors RUNTIME_HEALTH_COMPONENTS in @sdp/helius-rings, in the API's order. */
export const RINGS_HEALTH_COMPONENTS = ["rpc", "prover", "photon", "gateway"] as const;
export type RingsHealthComponent = (typeof RINGS_HEALTH_COMPONENTS)[number];

export type RingsHealth = Record<RingsHealthComponent, RingsHealthStatus> & {
  /**
   * Why a component reads the way it does — a probe's own classification, or a
   * gateway naming the environment variables it is missing. Keyed
   * `<component>.reason` by the API, and present only for the components that
   * recorded one, so an absent entry means "no reason given", never "healthy".
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
  | "failed";

/** Mirrors OP_TYPES in @sdp/helius-rings; a literal union so the typed i18n
 * keys (`activity.opType_*`) resolve. */
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
  opType: RingsOperationOpType;
  state: RingsOperationState;
  assetMint: string | null;
  amountRaw: string | null;
  createdAt: string;
}

export interface RingsOperationEvent {
  kind: string;
  createdAt: string;
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
 * Single reader for every `{ data } | { error }` response on this surface. The
 * body is parsed even on failure so the server's own `error.message` reaches
 * the caller rather than a generic string, and `.catch` absorbs a non-JSON
 * error page.
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
   * The server's own reason, whatever the status was.
   *
   * A 503 used to be collapsed into a single "awaiting integration" notice,
   * which was accurate while the only gateway was the unimplemented one. A live
   * gateway returns 503 for real, fixable conditions too — an unfunded owner,
   * an unreachable indexer — and rewriting those as "awaiting integration" tells
   * the operator to wait for something that already arrived.
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
   * uint64 base units as a decimal string. Never parse this into a JavaScript
   * number — anything past 2^53 rounds silently. `formatBaseUnits` renders it
   * with string arithmetic instead.
   */
  amountRaw: string;
  /**
   * The mint's scale, or null when the API knew of none. Null is not zero: zero
   * says the amount is already whole units, and rendering an unknown scale that
   * way states a magnitude the server never reported.
   */
  decimals: number | null;
}

export interface RingsWalletSync {
  balances: RingsShieldedBalance[];
  /**
   * The indexer could not read everything it found. The balances are still the
   * ones it did read, so this is what stops a partial answer being presented as
   * a complete one.
   */
  degraded: boolean;
  /** When the answer was true — not a position to resume from. */
  observedAt: string;
}

/**
 * Reads the wallet's shielded balances from the indexer. Only ever called from
 * an explicit operator action: a sync is a full indexer scan, and it advances
 * the wallet's recorded observation point, which is why the API puts it behind
 * the write permission.
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

/**
 * Mirrors RingsIdentityMismatch in @sdp/helius-rings; a literal union so the
 * typed i18n keys (`identity.mismatch_*`) resolve.
 */
export type RingsIdentityMismatch = "owner" | "nullifier_key" | "viewing_key";

export interface RingsWalletIdentity {
  status: RingsIdentityStatus;
  /** Canonical shielded address this deployment derives for the wallet. */
  derivedShieldedAddress: string;
  /** Canonical shielded address the registry publishes; null when unregistered. */
  publishedShieldedAddress: string | null;
  /** Which published half differs. Null unless `status` is `foreign`. */
  mismatch: RingsIdentityMismatch | null;
  /**
   * The identity our own row records, which the chain cannot tell us. Null on a
   * wallet whose provisioning never completed — which is the case this read
   * exists for.
   */
  recordedShieldedAddress: string | null;
}

/**
 * Reads what the Rings registry publishes for a wallet's owner.
 *
 * A GET behind the read permission: it reads one on-chain account and records
 * nothing, unlike a sync, which advances the wallet's stored observation point.
 * Still an explicit operator action rather than something the page does on
 * load — it costs an RPC round trip and derives key material server-side.
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

export type RingsOpType =
  | "shield"
  | "transfer_registered"
  | "transfer_anonymous"
  | "withdraw"
  | "merge"
  | "timelock_create";

export interface PrepareRingsOperationInput {
  walletId: string;
  opType: RingsOpType;
  asset?: { mint: string; amountRaw: string };
  to?: string;
  zoneId?: string;
  transferMode?: "registered" | "anonymous";
  timelock?: { unlockAt: string; beneficiary: string };
}

export async function prepareRingsOperation(
  input: PrepareRingsOperationInput
): Promise<{ operation?: RingsOperationDetail; error?: string }> {
  const response = await fetch("/api/dashboard/helius-rings/operations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...input, clientNonce: crypto.randomUUID() }),
    cache: "no-store",
  });
  const result = await readEnvelope<{ operation: RingsOperationDetail }>(response);
  if (!result.ok) {
    return { error: result.error };
  }
  return { operation: result.data.operation };
}

/**
 * Advances an operation the server has already cleared. The verdict is read
 * from the stored approval request server-side, so this carries no body.
 */
export async function executeRingsOperation(
  operationId: string
): Promise<{ operation?: RingsOperationDetail; error?: string }> {
  const response = await fetch(
    `/api/dashboard/helius-rings/operations/${encodeURIComponent(operationId)}/execute`,
    { method: "POST", cache: "no-store" }
  );
  const result = await readEnvelope<{ operation: RingsOperationDetail }>(response);
  if (!result.ok) {
    return { error: result.error };
  }
  return { operation: result.data.operation };
}

export async function retryRingsOperation(
  operationId: string
): Promise<{ operation?: RingsOperationDetail; error?: string }> {
  const response = await fetch(
    `/api/dashboard/helius-rings/operations/${encodeURIComponent(operationId)}/retry`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientNonce: crypto.randomUUID() }),
      cache: "no-store",
    }
  );
  const result = await readEnvelope<{ operation: RingsOperationDetail }>(response);
  if (!result.ok) {
    return { error: result.error };
  }
  return { operation: result.data.operation };
}

export interface RingsZone {
  id: string;
  name: string;
  kind: "treasury" | "public";
}

export function fetchRingsZones(
  walletId: string,
  fallbackError: string
): Promise<{ zones: RingsZone[] }> {
  return getJson(
    `/api/dashboard/helius-rings/wallets/${encodeURIComponent(walletId)}/zones`,
    fallbackError
  );
}

export async function createRingsZone(input: {
  walletId: string;
  name: string;
  kind: RingsZone["kind"];
}): Promise<{ zone?: RingsZone; error?: string }> {
  const response = await fetch(
    `/api/dashboard/helius-rings/wallets/${encodeURIComponent(input.walletId)}/zones`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: input.name, kind: input.kind }),
      cache: "no-store",
    }
  );
  const result = await readEnvelope<{ zone: RingsZone }>(response);
  if (!result.ok) {
    return { error: result.error };
  }
  return { zone: result.data.zone };
}

/** Devnet assets seeded in the rings allowlist. */
export const RINGS_ALLOWLISTED_ASSETS = [
  { mint: "So11111111111111111111111111111111111111112", symbol: "SOL", decimals: 9 },
  { mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", symbol: "USDC", decimals: 6 },
] as const;
