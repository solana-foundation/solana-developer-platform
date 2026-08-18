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

export interface RingsOperationDetail extends RingsOperationSummary {
  failure: { code: string; message: string; retryable: boolean } | null;
}

interface Envelope<T> {
  data?: T;
  error?: { message?: string };
}

async function getJson<T>(path: string, fallbackError: string): Promise<T> {
  const response = await fetch(path, { cache: "no-store" });
  const body = (await response.json().catch(() => ({}))) as Envelope<T>;
  if (!response.ok || !body.data) {
    throw new Error(body.error?.message ?? fallbackError);
  }
  return body.data;
}

export function fetchRingsHealth(fallbackError: string): Promise<{ health: RingsHealth }> {
  return getJson("/api/dashboard/helius-rings/health", fallbackError);
}

export function fetchRingsWallets(fallbackError: string): Promise<{ wallets: RingsWallet[] }> {
  return getJson("/api/dashboard/helius-rings/wallets", fallbackError);
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
  const body = (await response.json().catch(() => ({}))) as Envelope<{ wallet: RingsWallet }>;
  if (response.status === 503) {
    return { pendingIntegration: true };
  }
  if (!response.ok || !body.data) {
    return { pendingIntegration: false, error: body.error?.message };
  }
  return { wallet: body.data.wallet, pendingIntegration: false };
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
  const body = (await response.json().catch(() => ({}))) as Envelope<{
    operation: RingsOperationDetail;
  }>;
  if (!response.ok || !body.data) {
    return { error: body.error?.message };
  }
  return { operation: body.data.operation };
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
  const body = (await response.json().catch(() => ({}))) as Envelope<{ zone: RingsZone }>;
  if (!response.ok || !body.data) {
    return { error: body.error?.message };
  }
  return { zone: body.data.zone };
}

/** Devnet assets seeded in the rings allowlist. */
export const RINGS_ALLOWLISTED_ASSETS = [
  // biome-ignore lint/security/noSecrets: wrapped SOL mint address, not a secret.
  { mint: "So11111111111111111111111111111111111111112", symbol: "SOL", decimals: 9 },
  // biome-ignore lint/security/noSecrets: devnet USDC mint address, not a secret.
  { mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", symbol: "USDC", decimals: 6 },
] as const;
