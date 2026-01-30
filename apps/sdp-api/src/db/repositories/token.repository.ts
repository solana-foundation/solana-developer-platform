import type { Token } from "@sdp/types";
import type { DrizzleDbClient } from "./base";

export interface ListTokensOptions {
  status?: string;
  limit: number;
  offset: number;
}

export interface TokenRepositoryContext {
  db: DrizzleDbClient;
}

export interface TokenRepository {
  getById(tokenId: string): Promise<Token | null>;
  listByProject(
    projectId: string,
    options: ListTokensOptions
  ): Promise<{ tokens: Token[]; total: number }>;
}
