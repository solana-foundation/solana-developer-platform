import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { formatDecimalAmount } from "@/lib/amount";
import type { Token, TokenExtensionsConfig, TokenStatus, TokenTemplate } from "@sdp/types";
import { issuedTokenExtensions, issuedTokens } from "../drizzle/schema/sqlite";
import type { ListTokensOptions, TokenRepository, TokenRepositoryContext } from "./token.repository";

const parseExtensionValue = (value: string | null): unknown => {
  if (!value) {
    return true;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
};

const mapExtensionRows = (
  rows: Array<Pick<typeof issuedTokenExtensions.$inferSelect, "extension" | "config">>
): TokenExtensionsConfig | null => {
  if (!rows.length) {
    return null;
  }

  const config: Record<string, unknown> = {};

  for (const row of rows) {
    config[row.extension] = parseExtensionValue(row.config);
  }

  return config as TokenExtensionsConfig;
};

const mapTokenRow = (
  row: typeof issuedTokens.$inferSelect,
  extensions: TokenExtensionsConfig | null
): Token => ({
  id: row.id,
  projectId: row.projectId,
  organizationId: row.organizationId,
  mintAddress: row.mintAddress,
  mintAuthority: row.mintAuthority,
  freezeAuthority: row.freezeAuthority,
  ablListAddress: row.ablListAddress,
  name: row.name,
  symbol: row.symbol,
  decimals: row.decimals,
  description: row.description,
  uri: row.uri,
  imageUrl: row.imageUrl,
  template: (row.template ?? "custom") as TokenTemplate,
  extensions,
  totalSupply: formatDecimalAmount(row.totalSupply ?? "0", row.decimals),
  totalSupplyUpdatedAt: row.totalSupplyUpdatedAt,
  maxSupply: row.maxSupply ? formatDecimalAmount(row.maxSupply, row.decimals) : null,
  isMintable: row.isMintable === 1,
  isFreezable: row.isFreezable === 1,
  requiresAllowlist: row.requiresAllowlist === 1,
  status: row.status as TokenStatus,
  deployedAt: row.deployedAt,
  createdBy: row.createdBy,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const buildListWhere = (projectId: string, status?: string) => {
  if (status) {
    return and(eq(issuedTokens.projectId, projectId), eq(issuedTokens.status, status));
  }
  return eq(issuedTokens.projectId, projectId);
};

export const createD1TokenRepository = (
  context: TokenRepositoryContext
): TokenRepository => {
  const { db } = context;

  return {
    async getById(tokenId: string) {
      const row = await db
        .select()
        .from(issuedTokens)
        .where(eq(issuedTokens.id, tokenId))
        .get();

      if (!row) {
        return null;
      }

      const extensionsRows = await db
        .select({ extension: issuedTokenExtensions.extension, config: issuedTokenExtensions.config })
        .from(issuedTokenExtensions)
        .where(eq(issuedTokenExtensions.tokenId, tokenId))
        .all();

      return mapTokenRow(row, mapExtensionRows(extensionsRows));
    },

    async listByProject(projectId: string, options: ListTokensOptions) {
      const { status, limit, offset } = options;
      const whereClause = buildListWhere(projectId, status);

      const countRow = await db
        .select({ count: sql<number>`count(*)` })
        .from(issuedTokens)
        .where(whereClause)
        .get();

      const rows = await db
        .select()
        .from(issuedTokens)
        .where(whereClause)
        .orderBy(desc(issuedTokens.createdAt))
        .limit(limit)
        .offset(offset)
        .all();

      const tokenIds = rows.map((row) => row.id);
      const extensionRows = tokenIds.length
        ? await db
            .select({
              tokenId: issuedTokenExtensions.tokenId,
              extension: issuedTokenExtensions.extension,
              config: issuedTokenExtensions.config,
            })
            .from(issuedTokenExtensions)
            .where(inArray(issuedTokenExtensions.tokenId, tokenIds))
            .all()
        : [];

      const extensionMap = new Map<string, TokenExtensionsConfig | null>();

      for (const row of extensionRows) {
        const existing = extensionMap.get(row.tokenId) ?? {};
        const next = {
          ...(existing ?? {}),
          [row.extension]: parseExtensionValue(row.config),
        } as TokenExtensionsConfig;
        extensionMap.set(row.tokenId, next);
      }

      return {
        tokens: rows.map((row) => mapTokenRow(row, extensionMap.get(row.id) ?? null)),
        total: countRow?.count ?? 0,
      };
    },
  };
};
