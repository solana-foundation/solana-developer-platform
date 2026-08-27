import type { AppDb } from "@/db";
import type {
  HeliusRingsAssetRepository,
  HeliusRingsAssetRow,
} from "./helius-rings-asset.repository";

function mapRow(row: Record<string, unknown>): HeliusRingsAssetRow {
  return {
    mint: row.mint as string,
    symbol: row.symbol as string,
    decimals: Number(row.decimals),
    status: row.status as HeliusRingsAssetRow["status"],
  };
}

export function createPostgresHeliusRingsAssetRepository(db: AppDb): HeliusRingsAssetRepository {
  return {
    async listActiveAssets() {
      const result = await db
        .prepare(
          `SELECT mint, symbol, decimals, status FROM helius_rings_asset_allowlist
            WHERE status = 'active'
            ORDER BY symbol ASC, mint ASC`
        )
        .all<Record<string, unknown>>();
      return result.results.map(mapRow);
    },
  };
}
