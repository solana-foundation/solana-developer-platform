import type { KeyKind } from "@sdp/helius-rings";
import type { AppDb } from "@/db";
import {
  type CreateHeliusRingsKeyRefInput,
  generateHeliusRingsKeyRefId,
  type HeliusRingsKeyRefRepository,
  type HeliusRingsKeyRefRow,
} from "./helius-rings-key-ref.repository";

function mapRow(row: Record<string, unknown>): HeliusRingsKeyRefRow {
  return {
    id: row.id as string,
    wallet_id: row.wallet_id as string,
    kind: row.kind as HeliusRingsKeyRefRow["kind"],
    ciphertext: row.ciphertext as string,
    key_version: row.key_version as string,
    material_tag: row.material_tag as HeliusRingsKeyRefRow["material_tag"],
    created_at: row.created_at as string,
  };
}

export function createPostgresHeliusRingsKeyRefRepository(db: AppDb): HeliusRingsKeyRefRepository {
  return {
    async createKeyRef(input: CreateHeliusRingsKeyRefInput) {
      const id = generateHeliusRingsKeyRefId();
      const row = await db
        .prepare(
          `INSERT INTO helius_rings_key_refs (
             id,
             wallet_id,
             kind,
             ciphertext,
             key_version,
             material_tag
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (wallet_id, kind)
           -- Self-assignment returns the blob already sealed. Note it assigns
           -- created_at to itself rather than the incoming ciphertext: a replay
           -- must not overwrite sealed material, because the first blob is the
           -- one the shielded identity was derived from.
           DO UPDATE SET created_at = helius_rings_key_refs.created_at
           RETURNING *`
        )
        .bind(id, input.walletId, input.kind, input.ciphertext, input.keyVersion, input.materialTag)
        .first<Record<string, unknown>>();
      return row ? mapRow(row) : null;
    },

    async getKeyRef(input: { walletId: string; kind: KeyKind }) {
      const row = await db
        .prepare(`SELECT * FROM helius_rings_key_refs WHERE wallet_id = ? AND kind = ?`)
        .bind(input.walletId, input.kind)
        .first<Record<string, unknown>>();
      return row ? mapRow(row) : null;
    },

    async listKeyRefsByWallet(input: { walletId: string }) {
      const result = await db
        .prepare(`SELECT * FROM helius_rings_key_refs WHERE wallet_id = ? ORDER BY kind ASC`)
        .bind(input.walletId)
        .all<Record<string, unknown>>();
      return result.results.map(mapRow);
    },
  };
}
