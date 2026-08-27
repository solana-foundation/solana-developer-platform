import type { AppDb } from "@/db";
import type {
  HeliusRingsAssetAllowlistRow,
  HeliusRingsAssetRepository,
} from "./helius-rings-asset.repository";

function mapRow(row: Record<string, unknown>): HeliusRingsAssetAllowlistRow {
  return {
    mint: row.mint as string,
    symbol: row.symbol as string,
    decimals: Number(row.decimals),
    status: row.status as HeliusRingsAssetAllowlistRow["status"],
  };
}

export function createPostgresHeliusRingsAssetRepository(db: AppDb): HeliusRingsAssetRepository {
  return {
    async getActiveByMint(mint: string) {
      const row = await db
        .prepare(
          `SELECT mint, symbol, decimals, status
             FROM helius_rings_asset_allowlist
            WHERE mint = ? AND status = 'active'`
        )
        .bind(mint)
        .first<Record<string, unknown>>();
      return row ? mapRow(row) : null;
    },

    async listActive() {
      const result = await db
        .prepare(
          `SELECT mint, symbol, decimals, status
             FROM helius_rings_asset_allowlist
            WHERE status = 'active'
            ORDER BY symbol ASC, mint ASC`
        )
        .all<Record<string, unknown>>();
      return result.results.map(mapRow);
    },
  };
}
