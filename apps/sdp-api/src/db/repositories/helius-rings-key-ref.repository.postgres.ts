import type { KeyKind } from "@sdp/helius-rings";
import type { AppDb } from "@/db";
import {
  type CreateHeliusRingsKeyRefInput,
  generateHeliusRingsKeyRefId,
  type HeliusRingsKeyRefRepository,
  type HeliusRingsKeyRefRow,
  type StageHeliusRingsKeyRotationInput,
} from "./helius-rings-key-ref.repository";

function mapRow(row: Record<string, unknown>): HeliusRingsKeyRefRow {
  return {
    id: row.id as string,
    wallet_id: row.wallet_id as string,
    kind: row.kind as HeliusRingsKeyRefRow["kind"],
    ciphertext: row.ciphertext as string,
    key_version: row.key_version as string,
    material_tag: row.material_tag as HeliusRingsKeyRefRow["material_tag"],
    previous_ciphertext: (row.previous_ciphertext as string | null) ?? null,
    previous_key_version: (row.previous_key_version as string | null) ?? null,
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

    async stageKeyRefRotation(input: StageHeliusRingsKeyRotationInput) {
      const result = await db
        .prepare(
          // A single statement, so a process that dies cannot leave one kind on
          // the new generation and the other on the old. The count gate makes it
          // all-or-nothing: unless both rows exist and neither is already staged
          // it evaluates false for every row and nothing is written.
          `UPDATE helius_rings_key_refs AS k
              SET ciphertext = v.ciphertext,
                  key_version = v.key_version,
                  previous_ciphertext = k.ciphertext,
                  previous_key_version = k.key_version
             FROM (VALUES ('viewing', ?, ?), ('nullifier', ?, ?))
                    AS v(kind, ciphertext, key_version)
            WHERE k.wallet_id = ?
              AND k.kind = v.kind
              -- Never stage over a staged rotation: each slot holds one blob, and
              -- overwriting it would discard the only material that still derives
              -- the published identity.
              AND k.previous_ciphertext IS NULL
              AND (
                SELECT count(*)
                  FROM helius_rings_key_refs AS g
                 WHERE g.wallet_id = k.wallet_id
                   AND g.kind IN ('viewing', 'nullifier')
                   AND g.previous_ciphertext IS NULL
              ) = 2
          RETURNING k.*`
        )
        .bind(
          input.viewing.ciphertext,
          input.viewing.keyVersion,
          input.nullifier.ciphertext,
          input.nullifier.keyVersion,
          input.walletId
        )
        .all<Record<string, unknown>>();
      return result.results.map(mapRow);
    },

    async restoreKeyRefRotation(input: { walletId: string }) {
      const result = await db
        .prepare(
          `UPDATE helius_rings_key_refs
              SET ciphertext = previous_ciphertext,
                  key_version = COALESCE(previous_key_version, key_version),
                  previous_ciphertext = NULL,
                  previous_key_version = NULL
            WHERE wallet_id = ?
              AND previous_ciphertext IS NOT NULL
          RETURNING *`
        )
        .bind(input.walletId)
        .all<Record<string, unknown>>();
      return result.results.map(mapRow);
    },

    async commitKeyRefRotation(input: { walletId: string }) {
      const result = await db
        .prepare(
          `UPDATE helius_rings_key_refs
              SET previous_ciphertext = NULL,
                  previous_key_version = NULL
            WHERE wallet_id = ?
              AND previous_ciphertext IS NOT NULL
          RETURNING id`
        )
        .bind(input.walletId)
        .all<Record<string, unknown>>();
      return result.results.length;
    },
  };
}
