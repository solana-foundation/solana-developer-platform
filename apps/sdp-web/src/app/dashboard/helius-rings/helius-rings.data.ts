/**
 * Client seam for the Helius Rings workspace. Fetches go through the
 * /api/dashboard/helius-rings BFF proxies; view-model types mirror the API
 * DTOs without importing server packages.
 */

export type RingsHealthStatus = "green" | "amber" | "red";
export type RingsHealth = Record<"rpc" | "prover" | "photon" | "gateway", RingsHealthStatus>;

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
  /** Set when the gateway seam refused (503): the wallet stays pending. */
  pendingIntegration: boolean;
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
    if (result.status === 503) {
      return { pendingIntegration: true };
    }
    return { pendingIntegration: false, error: result.error };
  }
  return { wallet: result.data.wallet, pendingIntegration: false };
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
