import { assertValidAddress } from "@sdp/solana/address";
import type { TokenAllowlistEntry, TokenAllowlistResponse } from "@sdp/types";
import type { Context } from "hono";
import { z } from "zod";
import { getDb } from "@/db";
import { AppError, badRequestQuery, notFound } from "@/lib/errors";
import { created, noContent, paginated, success } from "@/lib/response";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { getLogger } from "@/runtime/logger";
import { resolveApiKeySigningWalletId } from "@/services/api-key-scope.service";
import { AuditService } from "@/services/audit.service";
import { createOrgSigner } from "@/services/solana";
import type { TokenService } from "@/services/token.service";
import type { Env } from "@/types/env";
import {
  createIssuanceMosaicService,
  getTenantTokenService,
  requireProjectScope,
} from "../helpers";
import { type addAllowlistSchema, listAllowlistQuerySchema } from "../schemas";

type AppContext = Context<{ Bindings: Env }>;

const DEFAULT_SURFPOOL_ABL_REMOVE_TIMEOUT_MS = 15_000;

function getSurfpoolAblRemoveTimeoutMs(env: Env): number {
  const timeoutMs = Number.parseInt(
    env.KORA_SURFPOOL_ABL_REMOVE_TIMEOUT_MS ?? String(DEFAULT_SURFPOOL_ABL_REMOVE_TIMEOUT_MS),
    10
  );

  return Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_SURFPOOL_ABL_REMOVE_TIMEOUT_MS;
}

function isTimeoutLikeError(error: unknown): error is Error {
  return error instanceof Error && /aborted|timed?\s*out|timeout/i.test(error.message);
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  void operation.catch(() => undefined);

  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * On-chain add for an allowlist row that is durably recorded as pending.
 *
 * A failed or timed-out submission can still land on-chain, so an ambiguous
 * failure must never delete the DB record or its audit trail. The row remains
 * pending and a retry can reconcile it. Confirmed membership promotes it to
 * active.
 */
async function syncNewAllowlistEntryOnChain(opts: {
  c: AppContext;
  organizationId: string;
  projectId: string;
  signingWalletId: string | null | undefined;
  tokenService: TokenService;
  entryId: string;
  list: ReturnType<typeof assertValidAddress>;
  wallet: ReturnType<typeof assertValidAddress>;
}): Promise<TokenAllowlistEntry> {
  const signer = await createOrgSigner(
    opts.c.env,
    opts.organizationId,
    opts.projectId,
    opts.signingWalletId ?? undefined
  );
  const mosaic = createIssuanceMosaicService(opts.c, signer, "sponsored");

  try {
    await mosaic.addToList({ list: opts.list, wallet: opts.wallet });
  } catch (error) {
    if (!(await mosaic.isWalletOnList(opts.list, opts.wallet))) {
      throw error;
    }
  }

  return opts.tokenService.activateAllowlistEntry(opts.entryId);
}

async function removeExistingAllowlistEntryOnChain(opts: {
  c: AppContext;
  list: ReturnType<typeof assertValidAddress>;
  wallet: ReturnType<typeof assertValidAddress>;
  organizationId: string;
  projectId: string;
  signingWalletId: string | null | undefined;
}): Promise<void> {
  const signer = await createOrgSigner(
    opts.c.env,
    opts.organizationId,
    opts.projectId,
    opts.signingWalletId ?? undefined
  );
  const mosaic = createIssuanceMosaicService(opts.c, signer, "sponsored");
  const removeOperation = mosaic.removeFromList({
    list: opts.list,
    wallet: opts.wallet,
  });

  try {
    if (opts.c.env.KORA_SURFPOOL_SHIM === "true") {
      await withTimeout(
        removeOperation,
        getSurfpoolAblRemoveTimeoutMs(opts.c.env),
        "Surfpool control-list removal timed out"
      );
    } else {
      await removeOperation;
    }
  } catch (error) {
    // Submission and confirmation errors are ambiguous: the removal may have
    // landed despite the client error, and retrying an already-absent member
    // must remain idempotent. Verify the authoritative on-chain state before
    // deciding whether the operation failed.
    try {
      if (!(await mosaic.isWalletOnList(opts.list, opts.wallet))) {
        return;
      }
    } catch (verificationError) {
      getLogger().warn(
        {
          list: opts.list,
          wallet: opts.wallet,
          error:
            verificationError instanceof Error
              ? verificationError.message
              : "Unknown verification error",
        },
        "Unable to verify control-list state after removal error"
      );
    }

    if (opts.c.env.KORA_SURFPOOL_SHIM === "true" && isTimeoutLikeError(error)) {
      getLogger().warn(
        {
          list: opts.list,
          wallet: opts.wallet,
          error: error.message,
        },
        "Surfpool control-list removal timed out; keeping DB revocation as test truth"
      );
      return;
    }

    throw error;
  }
}

/**
 * Which wallet signs an on-chain control-list change, under this key's scope.
 *
 * The token's own value cannot be handed to the signer directly: a key bound to
 * selected wallets would reach a wallet it was never granted, and a token that
 * names no wallet would fall back to the project default. A key that is not
 * wallet-scoped keeps resolving exactly as before.
 */
function resolveAllowlistSigningWalletId(
  auth: Parameters<typeof resolveApiKeySigningWalletId>[0],
  signingWalletId: string | null
): string | null {
  if (signingWalletId) {
    return resolveApiKeySigningWalletId(auth, signingWalletId, ["tokens:write"]);
  }

  try {
    return resolveApiKeySigningWalletId(auth, null, ["tokens:write"]);
  } catch (error) {
    // The shared resolver answers "specify a walletId" when several bindings and
    // no default leave the signer ambiguous, and this route carries no walletId
    // parameter. Only that answer is rewritten: a key with an authorized default
    // signs with it, and every other refusal already names its own cause.
    if (error instanceof AppError && error.code === "BAD_REQUEST") {
      throw new AppError(
        "FORBIDDEN",
        "Token has no signing wallet; set one before changing its control list"
      );
    }
    throw error;
  }
}

export const listAllowlist = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const { projectId, orgId } = requireProjectScope(c);

  const parsed = listAllowlistQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    throw badRequestQuery({ errors: z.treeifyError(parsed.error) });
  }
  const { page, pageSize, search, label } = parsed.data;

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

  const { entries, total } = await tokenService.listAllowlistEntries(tokenId, {
    search,
    label,
    limit: pageSize,
    offset,
  });

  return paginated(c, entries, { total, page, pageSize });
};

export const listAllowlistLabels = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const { projectId, orgId } = requireProjectScope(c);

  const tokenService = getTenantTokenService(c);
  const token = await tokenService.getToken({
    tokenId,
    organizationId: orgId,
    projectId,
  });

  if (!token) {
    throw notFound("Token");
  }

  const { labels, total } = await tokenService.listAllowlistLabels(tokenId);

  return success(c, { labels, total });
};

export const addAllowlistEntry = async (c: ValidatedBodyContext<typeof addAllowlistSchema>) => {
  const { tokenId } = c.req.param();
  const { auth, projectId, orgId } = requireProjectScope(c);

  const body = c.req.valid("json");

  const tokenService = getTenantTokenService(c);
  const token = await tokenService.getToken({
    tokenId,
    organizationId: orgId,
    projectId,
  });

  if (!token) {
    throw notFound("Token");
  }

  // An on-chain list is changed by signing, so resolve which wallet does it
  // under this key's scope rather than handing the token's own value straight
  // to the signer: a key bound to selected wallets must hold the token's
  // signing wallet, and a token without one must not silently fall back to the
  // project default the key was never granted.
  const signingWalletId = token.ablListAddress
    ? resolveAllowlistSigningWalletId(auth, token.signingWalletId)
    : null;

  try {
    let { entry } = await tokenService.addAllowlistEntry({
      tokenId,
      address: body.address,
      addedBy: auth.id,
      label: body.label,
      initialStatus: token.ablListAddress ? "pending" : "active",
    });

    const auditService = new AuditService(getDb(c.env));
    await auditService.log(c, {
      action: "create",
      resourceType: "token_allowlist",
      resourceId: entry.id,
      metadata: {
        tokenId,
        address: body.address,
        label: body.label,
        mode: token.ablListAddress ? "on-chain" : "database",
        syncStatus: token.ablListAddress ? "pending" : "not_required",
      },
    });

    if (token.ablListAddress) {
      entry = await syncNewAllowlistEntryOnChain({
        c,
        organizationId: auth.organizationId,
        projectId,
        signingWalletId,
        tokenService,
        entryId: entry.id,
        list: assertValidAddress(token.ablListAddress, "ablListAddress"),
        wallet: assertValidAddress(body.address, "address"),
      });
    }

    const response: TokenAllowlistResponse = { entry };
    return created(c, response);
  } catch (error) {
    if (error instanceof Error && error.message === "ADDRESS_ALREADY_ALLOWLISTED") {
      throw new AppError("CONFLICT", "Address is already on the control list");
    }
    throw error;
  }
};

export const removeAllowlistEntry = async (c: AppContext) => {
  const { tokenId, entryId } = c.req.param();
  const { auth, projectId, orgId } = requireProjectScope(c);

  const tokenService = getTenantTokenService(c);
  const token = await tokenService.getToken({
    tokenId,
    organizationId: orgId,
    projectId,
  });

  if (!token) {
    throw notFound("Token");
  }

  const entry = await tokenService.getAllowlistEntry(entryId);
  if (!entry || entry.tokenId !== tokenId) {
    throw notFound("Allowlist entry");
  }
  if (entry.status === "revoked") {
    return noContent(c);
  }

  // An on-chain list is changed by signing, so resolve which wallet does it
  // under this key's scope rather than handing the token's own value straight
  // to the signer: a key bound to selected wallets must hold the token's
  // signing wallet, and a token without one must not silently fall back to the
  // project default the key was never granted.
  const signingWalletId = token.ablListAddress
    ? resolveAllowlistSigningWalletId(auth, token.signingWalletId)
    : null;

  const auditService = new AuditService(getDb(c.env));
  const auditIntent = await auditService.beginCritical(c, {
    action: "revoke",
    resourceType: "token_allowlist",
    resourceId: entryId,
    metadata: {
      tokenId,
      address: entry.address,
      mode: token.ablListAddress ? "on-chain" : "database",
    },
  });
  let authoritativeEffectCompleted = false;

  try {
    // For on-chain lists, confirm authoritative removal before publishing the
    // final DB state. The helper reconciles ambiguous submission errors by
    // reading membership, so a timeout that landed still completes, while a
    // definite failure leaves the entry accurately active and safely retryable.
    if (token.ablListAddress) {
      await removeExistingAllowlistEntryOnChain({
        c,
        organizationId: auth.organizationId,
        projectId,
        signingWalletId,
        list: assertValidAddress(token.ablListAddress, "ablListAddress"),
        wallet: assertValidAddress(entry.address, "address"),
      });
      authoritativeEffectCompleted = true;
    }

    await tokenService.revokeAllowlistEntry(entryId);
    authoritativeEffectCompleted = true;
    await auditService.completeCritical(c, auditIntent);

    return noContent(c);
  } catch (error) {
    if (!authoritativeEffectCompleted) {
      await auditService.completeCritical(c, auditIntent, {
        status: "failure",
        metadata: { error: error instanceof Error ? error.message : "Unknown error" },
      });
    }
    throw error;
  }
};
