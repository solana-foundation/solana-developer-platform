import type {
  TokenTransaction,
  TokenTransactionListItem,
  TokenTransactionStatus,
  TokenTransactionType,
} from "@sdp/types";
import {
  findAssociatedTokenPda,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@solana-program/token-2022";
import type { Context } from "hono";
import { getDb } from "@/db";
import { getAuth } from "@/lib/auth";
import { AppError, notFound } from "@/lib/errors";
import { paginated } from "@/lib/response";
import { type Address, assertValidAddress } from "@/lib/solana";
import { assertApiKeyWalletAccess } from "@/services/api-key-scope.service";
import { createSigningService } from "@/services/domain/signing.service";
import { TokenService } from "@/services/token.service";
import type { Env } from "@/types/env";

type AppContext = Context<{ Bindings: Env }>;

const TOKEN_TRANSACTION_TYPES: TokenTransactionType[] = [
  "mint",
  "burn",
  "freeze",
  "unfreeze",
  "seize",
  "force_burn",
  "update_authority",
  "pause",
  "unpause",
  "deploy",
];

const TOKEN_TRANSACTION_STATUSES: TokenTransactionStatus[] = [
  "pending",
  "processing",
  "confirmed",
  "finalized",
  "failed",
];

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new AppError("BAD_REQUEST", `Invalid ${name} query parameter`);
  }

  return parsed;
}

function parseTransactionTypes(
  c: AppContext,
): TokenTransactionType[] | undefined {
  const values = c.req.queries("type") ?? [];
  if (values.length === 0) {
    return undefined;
  }

  const normalized = values.map((value) => value.trim()).filter(Boolean);
  if (normalized.length !== values.length) {
    throw new AppError("BAD_REQUEST", "Invalid type query parameter");
  }

  const invalid = normalized.filter(
    (value): value is string =>
      !TOKEN_TRANSACTION_TYPES.includes(value as TokenTransactionType),
  );
  if (invalid.length > 0) {
    throw new AppError("BAD_REQUEST", "Invalid type query parameter", {
      invalidTypes: invalid,
      allowedTypes: TOKEN_TRANSACTION_TYPES,
    });
  }

  return Array.from(new Set(normalized as TokenTransactionType[]));
}

function parseTransactionStatus(
  value: string | undefined,
): TokenTransactionStatus | undefined {
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
  walletId: string,
): Promise<{ publicKey: string }> {
  const auth = getAuth(c);
  assertApiKeyWalletAccess(auth, walletId, ["tokens:read"]);

  const signingService = createSigningService(c.env);
  const wallets = await signingService.getWalletsWithProviders(
    auth.organizationId,
    auth.projectId ?? undefined,
    { includeAllProviders: true },
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
    walletPublicKey: string;
  },
): Promise<Array<{ tokenId: string; tokenAccount: string }>> {
  const owner = assertValidAddress(options.walletPublicKey, "walletPublicKey");
  const candidates = await tokenService.listTransactionTokenCandidates({
    organizationId: options.organizationId,
    projectId: options.projectId,
  });
  const matches: Array<{ tokenId: string; tokenAccount: string }> = [];

  for (const candidate of candidates) {
    let mint: Address;
    try {
      mint = assertValidAddress(candidate.mintAddress, "mintAddress");
    } catch {
      continue;
    }

    const [tokenAccount] = await findAssociatedTokenPda({
      owner,
      mint,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    });
    matches.push({ tokenId: candidate.tokenId, tokenAccount });
  }

  return matches;
}

export const listTokenTransactions = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const auth = getAuth(c);

  const tokenService = new TokenService(getDb(c.env));
  const token = await tokenService.getToken(tokenId);

  if (!token || token.organizationId !== auth?.organizationId) {
    throw notFound("Token");
  }

  if (auth?.projectId && token.projectId !== auth.projectId) {
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
  const pageSize = Math.min(
    Number.parseInt(c.req.query("pageSize") ?? "50", 10),
    100,
  );
  const offset = (page - 1) * pageSize;

  const { transactions, total } = await tokenService.listTokenTransactions(
    tokenId,
    {
      status,
      organizationId: auth.organizationId,
      limit: pageSize,
      offset,
    },
  );

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
  const pageSize = Math.min(
    parsePositiveInteger(c.req.query("pageSize"), 50, "pageSize"),
    100,
  );
  const offset = (page - 1) * pageSize;
  const walletIdRaw = c.req.query("walletId");
  const walletId = walletIdRaw?.trim();
  if (walletIdRaw !== undefined && !walletId) {
    throw new AppError("BAD_REQUEST", "Invalid walletId query parameter");
  }

  const wallet = walletId ? await resolveWalletFilter(c, walletId) : null;
  const tokenAccounts = wallet
    ? await deriveTokenAccountMatches(tokenService, {
        organizationId: auth.organizationId,
        projectId: auth.projectId,
        walletPublicKey: wallet.publicKey,
      })
    : [];

  const { transactions, total } = await tokenService.listTransactions({
    organizationId: auth.organizationId,
    projectId: auth.projectId,
    types,
    status,
    wallet: wallet
      ? {
          publicKey: wallet.publicKey,
          tokenAccounts,
        }
      : undefined,
    limit: pageSize,
    offset,
  });

  return paginated<TokenTransactionListItem>(c, transactions, {
    total,
    page,
    pageSize,
  });
};
