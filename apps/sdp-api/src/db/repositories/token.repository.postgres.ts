import type { Token, TokenExtensionsConfig, TokenStatus, TokenTemplate } from "@sdp/types";
import type { AppDb } from "@/db";
import { formatDecimalAmount } from "@/lib/amount";
import type { ListTokensOptions, TokenRepository } from "./token.repository";

function buildInClause(length: number): string {
  return Array.from({ length }, () => "?").join(", ");
}

function parseExtensionValue(value: string | null): unknown {
  if (!value) {
    return true;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function mapTokenRow(
  row: Record<string, unknown>,
  extensions: TokenExtensionsConfig | null
): Token {
  const decimals = row.decimals as number;

  return {
    id: row.id as string,
    projectId: row.project_id as string,
    organizationId: row.organization_id as string,
    signingWalletId: (row.signing_wallet_id as string | null | undefined) ?? null,
    mintAddress: (row.mint_address as string | null | undefined) ?? null,
    mintAuthority: (row.mint_authority as string | null | undefined) ?? null,
    freezeAuthority: (row.freeze_authority as string | null | undefined) ?? null,
    ablListAddress: (row.abl_list_address as string | null | undefined) ?? null,
    name: row.name as string,
    symbol: row.symbol as string,
    decimals,
    description: (row.description as string | null | undefined) ?? null,
    uri: (row.uri as string | null | undefined) ?? null,
    imageUrl: (row.image_url as string | null | undefined) ?? null,
    template: ((row.template as string | null | undefined) ?? "custom") as TokenTemplate,
    extensions,
    totalSupply: formatDecimalAmount(
      (row.total_supply_cached as string | null | undefined) ?? "0",
      decimals
    ),
    totalSupplyUpdatedAt: (row.total_supply_updated_at as string | null | undefined) ?? null,
    maxSupply: row.max_supply ? formatDecimalAmount(row.max_supply as string, decimals) : null,
    isMintable: (row.is_mintable as number) === 1,
    isFreezable: (row.freeze_authority_enabled as number) === 1,
    requiresAllowlist: (row.allowlist_enabled as number) === 1,
    status: row.status as TokenStatus,
    deployedAt: (row.deployed_at as string | null | undefined) ?? null,
    createdBy: row.created_by as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function createPostgresTokenRepository(db: AppDb): TokenRepository {
  return {
    async getById(tokenId: string) {
      const row = await db
        .prepare("SELECT * FROM issued_tokens WHERE id = ?")
        .bind(tokenId)
        .first<Record<string, unknown>>();

      if (!row) {
        return null;
      }

      const extensionsRows = await db
        .prepare(
          `SELECT extension, config
           FROM issued_token_extensions
           WHERE token_id = ?`
        )
        .bind(tokenId)
        .all<{ extension: string; config: string | null }>();

      const extensions = extensionsRows.results.length
        ? (Object.fromEntries(
            extensionsRows.results.map((extensionRow) => [
              extensionRow.extension,
              parseExtensionValue(extensionRow.config),
            ])
          ) as TokenExtensionsConfig)
        : null;

      return mapTokenRow(row, extensions);
    },

    async listByProject(projectId: string, options: ListTokensOptions) {
      const clauses = ["project_id = ?"];
      const values: unknown[] = [projectId];

      if (options.status) {
        clauses.push("status = ?");
        values.push(options.status);
      }

      const whereClause = clauses.join(" AND ");

      const [countRow, rows] = await Promise.all([
        db
          .prepare(`SELECT COUNT(*) AS count FROM issued_tokens WHERE ${whereClause}`)
          .bind(...values)
          .first<{ count: number }>(),
        db
          .prepare(
            `SELECT *
             FROM issued_tokens
             WHERE ${whereClause}
             ORDER BY created_at DESC
             LIMIT ?
             OFFSET ?`
          )
          .bind(...values, options.limit, options.offset)
          .all<Record<string, unknown>>(),
      ]);

      const tokenIds = rows.results.map((row) => row.id as string);
      const extensionRows =
        tokenIds.length === 0
          ? { results: [] as Array<{ token_id: string; extension: string; config: string | null }> }
          : await db
              .prepare(
                `SELECT token_id, extension, config
                 FROM issued_token_extensions
                 WHERE token_id IN (${buildInClause(tokenIds.length)})`
              )
              .bind(...tokenIds)
              .all<{ token_id: string; extension: string; config: string | null }>();

      const extensionMap = new Map<string, TokenExtensionsConfig | null>();

      for (const row of extensionRows.results) {
        const existing = extensionMap.get(row.token_id) ?? {};
        extensionMap.set(row.token_id, {
          ...(existing ?? {}),
          [row.extension]: parseExtensionValue(row.config),
        } as TokenExtensionsConfig);
      }

      return {
        tokens: rows.results.map((row) =>
          mapTokenRow(row, extensionMap.get(row.id as string) ?? null)
        ),
        total: countRow?.count ?? 0,
      };
    },
  };
}
