import type { AppDb } from "@/db";
import {
  type CreateHeliusRingsWalletInput,
  DEFAULT_RINGS_WALLET_LIST_LIMIT,
  generateHeliusRingsWalletId,
  type HeliusRingsProjectScope,
  type HeliusRingsWalletRepository,
  type HeliusRingsWalletRow,
  type ListHeliusRingsWalletsInput,
  type MarkHeliusRingsWalletProvisionedInput,
  type UpdateHeliusRingsWalletStatusInput,
  type UpdateHeliusRingsWalletSyncCursorInput,
} from "./helius-rings-wallet.repository";

function mapRow(row: Record<string, unknown>): HeliusRingsWalletRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    project_id: row.project_id as string,
    sdp_wallet_id: row.sdp_wallet_id as string,
    name: row.name as string,
    network: row.network as string,
    status: row.status as HeliusRingsWalletRow["status"],
    shielded_address: (row.shielded_address ?? null) as string | null,
    owner_address: (row.owner_address ?? null) as string | null,
    sync_cursor: (row.sync_cursor ?? null) as string | null,
    // NUMERIC comes back as a string from pg, which is what a uint64 slot needs:
    // `number` would start rounding partway up the range the column allows.
    last_indexed_slot:
      row.last_indexed_slot === null || row.last_indexed_slot === undefined
        ? null
        : String(row.last_indexed_slot),
    custody_wallet_id: (row.custody_wallet_id ?? null) as string | null,
    material_tag: row.material_tag as HeliusRingsWalletRow["material_tag"],
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export function createPostgresHeliusRingsWalletRepository(db: AppDb): HeliusRingsWalletRepository {
  return {
    async createWallet(input: CreateHeliusRingsWalletInput) {
      const id = generateHeliusRingsWalletId();
      const row = await db
        .prepare(
          `INSERT INTO helius_rings_wallets (
             id,
             organization_id,
             project_id,
             sdp_wallet_id,
             name,
             material_tag,
             custody_wallet_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (project_id, sdp_wallet_id)
           -- Self-assignment so RETURNING * emits the row that already exists.
           -- DO NOTHING would return zero rows and make a retried provision
           -- look like a failure.
           DO UPDATE SET updated_at = helius_rings_wallets.updated_at,
                         -- Fills in the link for a wallet created before this
                         -- column existed, but never repoints one that is
                         -- already bound: the identity on chain was registered
                         -- to that custody wallet and cannot be moved.
                         custody_wallet_id = COALESCE(
                           helius_rings_wallets.custody_wallet_id,
                           EXCLUDED.custody_wallet_id
                         )
           RETURNING *`
        )
        .bind(
          id,
          input.organizationId,
          input.projectId,
          input.sdpWalletId,
          input.name,
          input.materialTag,
          input.custodyWalletId ?? null
        )
        .first<Record<string, unknown>>();
      return row ? mapRow(row) : null;
    },

    async getWalletById(scope: HeliusRingsProjectScope & { id: string }) {
      const row = await db
        .prepare(
          `SELECT * FROM helius_rings_wallets
            WHERE id = ? AND organization_id = ? AND project_id = ?`
        )
        .bind(scope.id, scope.organizationId, scope.projectId)
        .first<Record<string, unknown>>();
      return row ? mapRow(row) : null;
    },

    async getWalletBySdpWalletId(scope: HeliusRingsProjectScope & { sdpWalletId: string }) {
      const row = await db
        .prepare(
          `SELECT * FROM helius_rings_wallets
            WHERE sdp_wallet_id = ? AND organization_id = ? AND project_id = ?`
        )
        .bind(scope.sdpWalletId, scope.organizationId, scope.projectId)
        .first<Record<string, unknown>>();
      return row ? mapRow(row) : null;
    },

    async listWallets(input: ListHeliusRingsWalletsInput) {
      if (input.sdpWalletIds?.length === 0) return [];

      const bindings: unknown[] = [input.organizationId, input.projectId];
      const walletScope = input.sdpWalletIds ? " AND sdp_wallet_id = ANY(?)" : "";
      if (input.sdpWalletIds) bindings.push([...input.sdpWalletIds]);
      bindings.push(input.limit ?? DEFAULT_RINGS_WALLET_LIST_LIMIT);

      const result = await db
        .prepare(
          `SELECT * FROM helius_rings_wallets
            WHERE organization_id = ? AND project_id = ?${walletScope}
            ORDER BY created_at DESC, id DESC
            LIMIT ?`
        )
        .bind(...bindings)
        .all<Record<string, unknown>>();
      return result.results.map(mapRow);
    },

    async listWalletIdsBySdpWalletIds(input) {
      if (input.sdpWalletIds.length === 0) return [];

      const result = await db
        .prepare(
          `SELECT id FROM helius_rings_wallets
            WHERE organization_id = ?
              AND project_id = ?
              AND sdp_wallet_id = ANY(?)`
        )
        .bind(input.organizationId, input.projectId, [...input.sdpWalletIds])
        .all<{ id: string }>();
      return result.results.map((row) => row.id);
    },

    async markProvisioned(input: MarkHeliusRingsWalletProvisionedInput) {
      const row = await db
        .prepare(
          `UPDATE helius_rings_wallets
              SET status = 'ready',
                  shielded_address = ?,
                  owner_address = ?,
                  material_tag = ?,
                  updated_at = sdp_iso_now()
            WHERE id = ?
              AND organization_id = ?
              AND project_id = ?
              AND status = ?
          RETURNING *`
        )
        .bind(
          input.shieldedAddress,
          input.ownerAddress,
          input.materialTag,
          input.id,
          input.organizationId,
          input.projectId,
          input.expectedStatus
        )
        .first<Record<string, unknown>>();
      return row ? mapRow(row) : null;
    },

    async updateStatus(input: UpdateHeliusRingsWalletStatusInput) {
      const row = await db
        .prepare(
          `UPDATE helius_rings_wallets
              SET status = ?, updated_at = sdp_iso_now()
            WHERE id = ? AND organization_id = ? AND project_id = ?
          RETURNING *`
        )
        .bind(input.status, input.id, input.organizationId, input.projectId)
        .first<Record<string, unknown>>();
      return row ? mapRow(row) : null;
    },

    async advanceIndexedSlot(input: HeliusRingsProjectScope & { id: string; slot: string }) {
      const row = await db
        .prepare(
          `UPDATE helius_rings_wallets
              SET last_indexed_slot = GREATEST(COALESCE(last_indexed_slot, 0), ?::numeric),
                  updated_at = sdp_iso_now()
            WHERE id = ? AND organization_id = ? AND project_id = ?
          RETURNING *`
        )
        .bind(input.slot, input.id, input.organizationId, input.projectId)
        .first<Record<string, unknown>>();
      return row ? mapRow(row) : null;
    },

    async updateSyncCursor(input: UpdateHeliusRingsWalletSyncCursorInput) {
      const row = await db
        .prepare(
          `UPDATE helius_rings_wallets
              SET sync_cursor = ?, updated_at = sdp_iso_now()
            WHERE id = ? AND organization_id = ? AND project_id = ?
          RETURNING *`
        )
        .bind(input.syncCursor, input.id, input.organizationId, input.projectId)
        .first<Record<string, unknown>>();
      return row ? mapRow(row) : null;
    },
  };
}
