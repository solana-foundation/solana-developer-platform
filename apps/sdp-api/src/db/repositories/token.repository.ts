import type { Token, TokenStatus } from "@sdp/types";
import type { RepositoryDbClient } from "./base";

export interface ListTokensOptions {
  status?: string;
  limit: number;
  offset: number;
}

export interface TokenRepositoryContext {
  db: RepositoryDbClient;
}

export interface TokenRepository {
  getById(tokenId: string): Promise<Token | null>;
  getStatusByMint(projectId: string, mintAddress: string): Promise<TokenStatus | null>;
  listByProject(
    projectId: string,
    options: ListTokensOptions
  ): Promise<{ tokens: Token[]; total: number }>;
}
