import { and, desc, eq, sql } from "drizzle-orm";
import type { Token, TokenExtensionsConfig, TokenStatus, TokenTemplate } from "@sdp/types";
import { tokens } from "../drizzle/schema/sqlite";
import type { ListTokensOptions, TokenRepository, TokenRepositoryContext } from "./token.repository";

const parseExtensions = (value: string | null): TokenExtensionsConfig | null => {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as TokenExtensionsConfig;
  } catch {
    return null;
  }
};

const mapTokenRow = (row: typeof tokens.$inferSelect): Token => ({
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
  extensions: parseExtensions(row.extensions),
  totalSupply: row.totalSupply ?? "0",
  maxSupply: row.maxSupply,
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
    return and(eq(tokens.projectId, projectId), eq(tokens.status, status));
  }
  return eq(tokens.projectId, projectId);
};

export const createD1TokenRepository = (
  context: TokenRepositoryContext
): TokenRepository => {
  const { db } = context;

  return {
    async getById(tokenId: string) {
      const row = await db.select().from(tokens).where(eq(tokens.id, tokenId)).get();
      return row ? mapTokenRow(row) : null;
    },

    async listByProject(projectId: string, options: ListTokensOptions) {
      const { status, limit, offset } = options;
      const whereClause = buildListWhere(projectId, status);

      const countRow = await db
        .select({ count: sql<number>`count(*)` })
        .from(tokens)
        .where(whereClause)
        .get();

      const rows = await db
        .select()
        .from(tokens)
        .where(whereClause)
        .orderBy(desc(tokens.createdAt))
        .limit(limit)
        .offset(offset)
        .all();

      return {
        tokens: rows.map(mapTokenRow),
        total: countRow?.count ?? 0,
      };
    },
  };
};
