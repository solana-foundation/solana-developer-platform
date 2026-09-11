import { type Address, assertValidAddress } from "@sdp/solana/address";
import {
  TOKEN_TRANSACTION_STATUSES,
  TOKEN_TRANSACTION_TYPES,
  type TokenTransactionStatus,
  type TokenTransactionType,
} from "@sdp/types";
import { findAssociatedTokenPda, TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import type { Context } from "hono";
import { z } from "zod";
import { getDb } from "@/db";
import { getAuth } from "@/lib/auth";
import { badRequest, badRequestQuery, notFound, walletNotFound } from "@/lib/errors";
import { paginated } from "@/lib/response";
import {
  assertApiKeyWalletAccess,
  getAllowedApiKeyCustodyWalletIdsForPermissions,
} from "@/services/api-key-scope.service";
import { CustodyRuntimeTargets } from "@/services/domain/signing/custody-runtime-target";
import type { TokenService } from "@/services/token.service";
import type { Env } from "@/types/env";
import { getTenantTokenService, requireProjectScope } from "../helpers";
import {
  issuanceTransactionWalletFilterSchema,
  listTokenTransactionsQuerySchema,
} from "../schemas";
import { resolveIssuanceWallet } from "./authority-resolution";
import { toPublicTokenTransaction, toPublicTokenTransactionListItem } from "./public-response";

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
    throw badRequest(`Invalid ${name} query parameter`);
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
    throw badRequest("Invalid type query parameter");
  }

  const invalid = normalized.filter(
    (value): value is string => !TOKEN_TRANSACTION_TYPES.includes(value as TokenTransactionType)
  );
  if (invalid.length > 0) {
    throw badRequest("Invalid type query parameter", {
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
    throw badRequest("Invalid status query parameter", {
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

  const wallet = await new CustodyRuntimeTargets(
    getDb(c.env),
    c.env,
    new Map()
  ).findOperationalWallet({
    organizationId: auth.organizationId,
    projectId: auth.projectId ?? undefined,
    walletId,
  });

  if (!wallet) {
    throw walletNotFound();
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
  selectors: { custodyWalletId?: string; walletId?: string }
): Promise<WalletTransactionScope | undefined> {
  const auth = getAuth(c);
  const { custodyWalletId, walletId } = selectors;

  if (custodyWalletId) {
    const wallet = await resolveIssuanceWallet({
      env: c.env,
      auth,
      custodyWalletId,
      requiredWalletPermissions: ["tokens:read"],
    });
    return buildWalletTransactionScope(tokenService, {
      organizationId: auth.organizationId,
      projectId: auth.projectId,
      publicKeys: [wallet.publicKey],
    });
  }

  if (walletId) {
    const wallet = await resolveWalletFilter(c, walletId);
    return buildWalletTransactionScope(tokenService, {
      organizationId: auth.organizationId,
      projectId: auth.projectId,
      publicKeys: [wallet.publicKey],
    });
  }

  const allowedCustodyWalletIds = getAllowedApiKeyCustodyWalletIdsForPermissions(auth, [
    "tokens:read",
  ]);
  if (allowedCustodyWalletIds === null) {
    return undefined;
  }
  if (allowedCustodyWalletIds.length === 0) {
    return { publicKeys: [], tokenAccounts: [] };
  }

  const allowedWalletIdSet = new Set(allowedCustodyWalletIds);
  const wallets = await new CustodyRuntimeTargets(getDb(c.env), c.env, new Map()).listWallets({
    organizationId: auth.organizationId,
    projectId: auth.projectId ?? undefined,
    includeAllProviders: true,
  });
  const publicKeys = wallets
    .filter((wallet) => allowedWalletIdSet.has(wallet.id))
    .map((wallet) => wallet.publicKey);

  return buildWalletTransactionScope(tokenService, {
    organizationId: auth.organizationId,
    projectId: auth.projectId,
    publicKeys,
  });
}

export const listTokenTransactions = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const { projectId, orgId } = requireProjectScope(c);

  const parsed = listTokenTransactionsQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    throw badRequestQuery({ errors: z.treeifyError(parsed.error) });
  }
  const { page, pageSize, status, type } = parsed.data;

  const tokenService = getTenantTokenService(c);
  const token = await tokenService.getToken({
    tokenId,
    organizationId: orgId,
    projectId,
  });

  if (!token) {
    throw notFound("Token");
  }

  const offset = (page - 1) * pageSize;

  const { transactions, total } = await tokenService.listTokenTransactions(tokenId, {
    status,
    type,
    organizationId: orgId,
    limit: pageSize,
    offset,
  });

  return paginated(c, transactions.map(toPublicTokenTransaction), {
    total,
    page,
    pageSize,
  });
};

export const listTransactions = async (c: AppContext) => {
  const auth = getAuth(c);
  const tokenService = getTenantTokenService(c);
  const types = parseTransactionTypes(c);
  const status = parseTransactionStatus(c.req.query("status"));
  const page = parsePositiveInteger(c.req.query("page"), 1, "page");
  const pageSize = Math.min(parsePositiveInteger(c.req.query("pageSize"), 50, "pageSize"), 100);
  const offset = (page - 1) * pageSize;
  const walletFilter = issuanceTransactionWalletFilterSchema.safeParse({
    custodyWalletId: c.req.query("custodyWalletId"),
    walletId: c.req.query("walletId"),
  });
  if (!walletFilter.success) {
    throw badRequestQuery({ errors: z.treeifyError(walletFilter.error) });
  }

  const walletScope = await resolveWalletTransactionScope(c, tokenService, walletFilter.data);

  const { transactions, total } = await tokenService.listTransactions({
    organizationId: auth.organizationId,
    projectId: auth.projectId,
    types,
    status,
    walletScope,
    limit: pageSize,
    offset,
  });

  return paginated(c, transactions.map(toPublicTokenTransactionListItem), {
    total,
    page,
    pageSize,
  });
};
