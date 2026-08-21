import type { MaterialTag, PrivateWallet, WalletStatus } from "@sdp/helius-rings";
import type { RepositoryDbClient } from "./base";

export function generateHeliusRingsWalletId(): string {
  return `hrw_${crypto.randomUUID()}`;
}

/** Upper bound on an unpaginated wallet list. */
export const DEFAULT_RINGS_WALLET_LIST_LIMIT = 100;

export interface HeliusRingsWalletRow {
  id: string;
  organization_id: string;
  project_id: string;
  sdp_wallet_id: string;
  name: string;
  /** Always 'devnet' for this scope; the DB CHECK enforces it. */
  network: string;
  status: WalletStatus;
  /** Null until the gateway provisions the shielded identity. */
  shielded_address: string | null;
  /** Photon sync cursor; null before the first successful sync. */
  sync_cursor: string | null;
  material_tag: MaterialTag;
  created_at: string;
  updated_at: string;
}

export interface HeliusRingsProjectScope {
  organizationId: string;
  projectId: string;
}

/**
 * Wallets are always inserted as `pending` with no shielded address — those
 * arrive from the gateway via `markProvisioned`.
 */
export interface CreateHeliusRingsWalletInput extends HeliusRingsProjectScope {
  sdpWalletId: string;
  name: string;
  materialTag: MaterialTag;
}

export interface MarkHeliusRingsWalletProvisionedInput extends HeliusRingsProjectScope {
  id: string;
  shieldedAddress: string;
  materialTag: MaterialTag;
  /**
   * Compare-and-swap guard: only applies while the wallet is still in this
   * status, so a late provisioning callback cannot resurrect a paused wallet.
   */
  expectedStatus: WalletStatus;
}

export interface UpdateHeliusRingsWalletStatusInput extends HeliusRingsProjectScope {
  id: string;
  status: WalletStatus;
}

export interface UpdateHeliusRingsWalletSyncCursorInput extends HeliusRingsProjectScope {
  id: string;
  syncCursor: string;
}

export interface ListHeliusRingsWalletsInput extends HeliusRingsProjectScope {
  limit?: number;
}

export interface HeliusRingsWalletRepositoryContext {
  db: RepositoryDbClient;
}

export interface HeliusRingsWalletRepository {
  /**
   * Reserves the one wallet allowed per (project, sdpWalletId). On a replay it
   * returns the wallet already there rather than a second one, so provisioning
   * is safe to retry.
   */
  createWallet(input: CreateHeliusRingsWalletInput): Promise<HeliusRingsWalletRow | null>;
  getWalletById(
    scope: HeliusRingsProjectScope & { id: string }
  ): Promise<HeliusRingsWalletRow | null>;
  getWalletBySdpWalletId(
    scope: HeliusRingsProjectScope & { sdpWalletId: string }
  ): Promise<HeliusRingsWalletRow | null>;
  listWallets(input: ListHeliusRingsWalletsInput): Promise<HeliusRingsWalletRow[]>;
  /** Returns null when the CAS guard loses, leaving the row untouched. */
  markProvisioned(
    input: MarkHeliusRingsWalletProvisionedInput
  ): Promise<HeliusRingsWalletRow | null>;
  updateStatus(input: UpdateHeliusRingsWalletStatusInput): Promise<HeliusRingsWalletRow | null>;
  updateSyncCursor(
    input: UpdateHeliusRingsWalletSyncCursorInput
  ): Promise<HeliusRingsWalletRow | null>;
}

/**
 * Row to domain object. `organization_id`/`project_id` are dropped: the domain
 * `PrivateWallet` is what the API returns, and the caller already knows the
 * scope it queried by.
 */
export function mapHeliusRingsWalletRow(row: HeliusRingsWalletRow): PrivateWallet {
  return {
    id: row.id,
    sdpWalletId: row.sdp_wallet_id,
    name: row.name,
    shieldedAddress: row.shielded_address ?? null,
    status: row.status,
    // The DB CHECK pins this column to 'devnet', which is what makes the cast
    // to the domain literal honest rather than hopeful.
    network: "devnet",
    syncCursor: row.sync_cursor ?? null,
    materialTag: row.material_tag,
  };
}
