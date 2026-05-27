import {
  TOKEN_TRANSACTION_STATUSES,
  TOKEN_TRANSACTION_TYPES,
  type TokenTransaction,
  type TokenTransactionListItem,
  type TokenTransactionStatus,
  type TokenTransactionType,
} from "@sdp/types";
import { findAssociatedTokenPda, TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import type { Context } from "hono";
import { getDb } from "@/db";
import { getAuth } from "@/lib/auth";
import { AppError, notFound } from "@/lib/errors";
import { paginated } from "@/lib/response";
import { type Address, assertValidAddress } from "@/lib/solana";
import {
  assertApiKeyWalletAccess,
  getAllowedApiKeyWalletIdsForPermissions,
} from "@/services/api-key-scope.service";
import { createSigningService } from "@/services/domain/signing.service";
import { TokenService } from "@/services/token.service";
import type { Env } from "@/types/env";

type AppContext = Context<{ Bindings: Env }>;

interface WalletTransactionScope {
  publicKeys: string[];
  tokenAccounts: Array<{ tokenId: string; tokenAccount: string }>;
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new AppError("BAD_REQUEST", `Invalid ${name} query parameter`);
  }

  return parsed;
}

function parseTransactionTypes(c: AppContext): TokenTransactionType[] | undefined {
  const values = c.req.queries("type") ?? [];
  if (values.length === 0) {
    return undefined;
  }

  const normalized = values.map((value) => value.trim()).filter(Boolean);
  if (normalized.length !== values.length) {
    throw new AppError("BAD_REQUEST", "Invalid type query parameter");
  }

  const invalid = normalized.filter(
    (value): value is string => !TOKEN_TRANSACTION_TYPES.includes(value as TokenTransactionType)
  );
  if (invalid.length > 0) {
    throw new AppError("BAD_REQUEST", "Invalid type query parameter", {
      invalidTypes: invalid,
      allowedTypes: TOKEN_TRANSACTION_TYPES,
    });
  }

  return Array.from(new Set(normalized as TokenTransactionType[]));
}

function parseTransactionStatus(value: string | undefined): TokenTransactionStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!TOKEN_TRANSACTION_STATUSES.includes(value as TokenTransactionStatus)) {
    throw new AppError("BAD_REQUEST", "Invalid status query parameter", {
      allowedStatuses: TOKEN_TRANSACTION_STATUSES,
    });
  }

  return value as TokenTransactionStatus;
}

async function resolveWalletFilter(
  c: AppContext,
  walletId: string
): Promise<{ publicKey: string }> {
  const auth = getAuth(c);

  assertApiKeyWalletAccess(auth, walletId, ["tokens:read"]);

  const signingService = createSigningService(c.env);
  const wallets = await signingService.getWalletsWithProviders(
    auth.organizationId,
    auth.projectId ?? undefined,
    { includeAllProviders: true }
  );
  const wallet = wallets.find((entry) => entry.walletId === walletId);

  if (!wallet) {
    throw notFound("Wallet");
  }

  return { publicKey: wallet.publicKey };
}

async function deriveTokenAccountMatches(
  tokenService: TokenService,
  options: {
    organizationId: string;
    projectId?: string | null;
    walletPublicKeys: string[];
  }
): Promise<Array<{ tokenId: string; tokenAccount: string }>> {
  if (options.walletPublicKeys.length === 0) {
    return [];
  }

  const owners = options.walletPublicKeys.map((publicKey) =>
    assertValidAddress(publicKey, "walletPublicKey")
  );
  const candidates = await tokenService.listTransactionTokenCandidates({
    organizationId: options.organizationId,
    projectId: options.projectId,
  });
  const matches: Array<{ tokenId: string; tokenAccount: string }> = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    let mint: Address;
    try {
      mint = assertValidAddress(candidate.mintAddress, "mintAddress");
    } catch {
      continue;
    }

    for (const owner of owners) {
      const [tokenAccount] = await findAssociatedTokenPda({
        owner,
        mint,
        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      });
      const key = `${candidate.tokenId}:${tokenAccount}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      matches.push({ tokenId: candidate.tokenId, tokenAccount });
    }
  }

  return matches;
}

async function buildWalletTransactionScope(
  tokenService: TokenService,
  options: {
    organizationId: string;
    projectId?: string | null;
    publicKeys: string[];
  }
): Promise<WalletTransactionScope> {
  const publicKeys = Array.from(new Set(options.publicKeys));
  const tokenAccounts = await deriveTokenAccountMatches(tokenService, {
    organizationId: options.organizationId,
    projectId: options.projectId,
    walletPublicKeys: publicKeys,
  });

  return { publicKeys, tokenAccounts };
}

async function resolveWalletTransactionScope(
  c: AppContext,
  tokenService: TokenService,
  walletId?: string
): Promise<WalletTransactionScope | undefined> {
  const auth = getAuth(c);

  if (walletId) {
    const wallet = await resolveWalletFilter(c, walletId);
    return buildWalletTransactionScope(tokenService, {
      organizationId: auth.organizationId,
      projectId: auth.projectId,
      publicKeys: [wallet.publicKey],
    });
  }

  const allowedWalletIds = getAllowedApiKeyWalletIdsForPermissions(auth, ["tokens:read"]);
  if (allowedWalletIds === null) {
    return undefined;
  }
  if (allowedWalletIds.length === 0) {
    return { publicKeys: [], tokenAccounts: [] };
  }

  const allowedWalletIdSet = new Set(allowedWalletIds);
  const signingService = createSigningService(c.env);
  const wallets = await signingService.getWalletsWithProviders(
    auth.organizationId,
    auth.projectId ?? undefined,
    { includeAllProviders: true }
  );
  const publicKeys = wallets
    .filter((wallet) => allowedWalletIdSet.has(wallet.walletId))
    .map((wallet) => wallet.publicKey);

  return buildWalletTransactionScope(tokenService, {
    organizationId: auth.organizationId,
    projectId: auth.projectId,
    publicKeys,
  });
}

export const listTokenTransactions = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const auth = getAuth(c);

  const tokenService = new TokenService(getDb(c.env));
  const token = await tokenService.getToken(tokenId);

  if (!token || token.organizationId !== auth?.organizationId) {
    throw notFound("Token");
  }

  if (token.projectId !== auth.projectId) {
    throw notFound("Token");
  }

  const status = c.req.query("status") as
    | "pending"
    | "processing"
    | "confirmed"
    | "finalized"
    | "failed"
    | undefined;
  const page = Number.parseInt(c.req.query("page") ?? "1", 10);
  const pageSize = Math.min(Number.parseInt(c.req.query("pageSize") ?? "50", 10), 100);
  const offset = (page - 1) * pageSize;

  const { transactions, total } = await tokenService.listTokenTransactions(tokenId, {
    status,
    organizationId: auth.organizationId,
    limit: pageSize,
    offset,
  });

  return paginated<TokenTransaction>(c, transactions, {
    total,
    page,
    pageSize,
  });
};

export const listTransactions = async (c: AppContext) => {
  const auth = getAuth(c);
  const tokenService = new TokenService(getDb(c.env));
  const types = parseTransactionTypes(c);
  const status = parseTransactionStatus(c.req.query("status"));
  const page = parsePositiveInteger(c.req.query("page"), 1, "page");
  const pageSize = Math.min(parsePositiveInteger(c.req.query("pageSize"), 50, "pageSize"), 100);
  const offset = (page - 1) * pageSize;
  const walletIdRaw = c.req.query("walletId");
  const walletId = walletIdRaw?.trim();
  if (walletIdRaw !== undefined && !walletId) {
    throw new AppError("BAD_REQUEST", "Invalid walletId query parameter");
  }

  const walletScope = await resolveWalletTransactionScope(c, tokenService, walletId);

  const { transactions, total } = await tokenService.listTransactions({
    organizationId: auth.organizationId,
    projectId: auth.projectId,
    types,
    status,
    walletScope,
    limit: pageSize,
    offset,
  });

  return paginated<TokenTransactionListItem>(c, transactions, {
    total,
    page,
    pageSize,
  });
};
