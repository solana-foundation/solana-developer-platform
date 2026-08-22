import type { AppDb } from "@/db";
import {
  type CreateHeliusRingsZoneInput,
  generateHeliusRingsZoneId,
  type HeliusRingsZoneRepository,
  type HeliusRingsZoneRow,
} from "./helius-rings-zone.repository";

function mapRow(row: Record<string, unknown>): HeliusRingsZoneRow {
  return {
    id: row.id as string,
    wallet_id: row.wallet_id as string,
    name: row.name as string,
    kind: row.kind as HeliusRingsZoneRow["kind"],
    created_at: row.created_at as string,
  };
}

export function createPostgresHeliusRingsZoneRepository(db: AppDb): HeliusRingsZoneRepository {
  return {
    async createZone(input: CreateHeliusRingsZoneInput) {
      const id = generateHeliusRingsZoneId();
      const row = await db
        .prepare(
          `INSERT INTO helius_rings_zones (id, wallet_id, name, kind)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (wallet_id, name)
           -- Self-assignment so a replayed zone_create returns the existing zone
           -- rather than zero rows. The kind is not overwritten: renaming a
           -- zone's kind under a live operation would move its destination.
           DO UPDATE SET created_at = helius_rings_zones.created_at
           RETURNING *`
        )
        .bind(id, input.walletId, input.name, input.kind)
        .first<Record<string, unknown>>();
      return row ? mapRow(row) : null;
    },

    async getZoneById(input: { id: string; walletId: string }) {
      const row = await db
        .prepare(`SELECT * FROM helius_rings_zones WHERE id = ? AND wallet_id = ?`)
        .bind(input.id, input.walletId)
        .first<Record<string, unknown>>();
      return row ? mapRow(row) : null;
    },

    async listZonesByWallet(input: { walletId: string }) {
      const result = await db
        .prepare(
          `SELECT * FROM helius_rings_zones
            WHERE wallet_id = ?
            ORDER BY created_at DESC, id DESC`
        )
        .bind(input.walletId)
        .all<Record<string, unknown>>();
      return result.results.map(mapRow);
    },
  };
}
