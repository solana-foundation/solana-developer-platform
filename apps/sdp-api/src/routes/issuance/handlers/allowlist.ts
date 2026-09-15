import { assertValidAddress } from "@sdp/solana/address";
import type { TokenAllowlistEntry, TokenAllowlistResponse } from "@sdp/types";
import type { TransactionSigner } from "@solana/kit";
import type { Context } from "hono";
import { z } from "zod";
import { getDb } from "@/db";
import type { ApiKeyContext } from "@/lib/auth";
import { AppError, badRequestQuery, notFound } from "@/lib/errors";
import { created, noContent, paginated, success } from "@/lib/response";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { getLogger } from "@/runtime/logger";
import { AuditService } from "@/services/audit.service";
import type { TokenService } from "@/services/token.service";
import type { Env } from "@/types/env";
import {
  createIssuanceMosaicService,
  getTenantTokenService,
  requireProjectScope,
} from "../helpers";
import {
  type addAllowlistSchema,
  listAllowlistQuerySchema,
  removeAllowlistQuerySchema,
} from "../schemas";
import {
  admitIssuanceRuntimeExecution,
  createResolvedAuthoritySigner,
  resolveAllowlistAuthority,
  resolveAuthorityWallet,
} from "./authority-resolution";

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
  signer: TransactionSigner;
  tokenService: TokenService;
  entryId: string;
  list: ReturnType<typeof assertValidAddress>;
  wallet: ReturnType<typeof assertValidAddress>;
}): Promise<TokenAllowlistEntry> {
  const mosaic = createIssuanceMosaicService(opts.c, opts.signer, "sponsored");

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
  signer: TransactionSigner;
  list: ReturnType<typeof assertValidAddress>;
  wallet: ReturnType<typeof assertValidAddress>;
}): Promise<void> {
  const mosaic = createIssuanceMosaicService(opts.c, opts.signer, "sponsored");
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

async function resolveAllowlistAuthoritySigner(
  c: AppContext,
  auth: ApiKeyContext,
  tokenService: TokenService,
  list: ReturnType<typeof assertValidAddress>,
  signingCustodyWalletId?: string
) {
  const authority = await resolveAllowlistAuthority(c.env, list);
  const authorityWallet = await resolveAuthorityWallet({
    env: c.env,
    auth,
    currentAuthority: authority,
    requestedCustodyWalletId: signingCustodyWalletId,
    requiredWalletPermissions: ["tokens:write"],
  });
  await admitIssuanceRuntimeExecution({
    env: c.env,
    auth,
    custodyWalletId: authorityWallet.custodyWalletId,
    tokenService,
  });
  const signer = await createResolvedAuthoritySigner({
    env: c.env,
    auth,
    custodyWalletId: authorityWallet.custodyWalletId,
    currentAuthority: authority,
    requiredWalletPermissions: ["tokens:write"],
  });
  return { ...authorityWallet, signer };
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

  try {
    const list = token.ablListAddress
      ? assertValidAddress(token.ablListAddress, "ablListAddress")
      : null;
    const authorityWallet = list
      ? await resolveAllowlistAuthoritySigner(
          c,
          auth,
          tokenService,
          list,
          body.signingCustodyWalletId
        )
      : null;

    let { entry } = await tokenService.addAllowlistEntry({
      tokenId,
      address: body.address,
      addedBy: auth.id,
      label: body.label,
      initialStatus: token.ablListAddress ? "pending" : "active",
    });

    const auditService = new AuditService(getDb(c.env));
    if (list && authorityWallet) {
      const auditIntent = await auditService.beginCritical(c, {
        action: "create",
        resourceType: "token_allowlist",
        resourceId: entry.id,
        metadata: {
          tokenId,
          address: body.address,
          label: body.label,
          mode: "on-chain",
          syncStatus: "pending",
          custodyWalletId: authorityWallet.custodyWalletId,
        },
      });
      try {
        entry = await syncNewAllowlistEntryOnChain({
          c,
          signer: authorityWallet.signer,
          tokenService,
          entryId: entry.id,
          list,
          wallet: assertValidAddress(body.address, "address"),
        });
        await auditService.completeCritical(c, auditIntent, {
          metadata: { syncStatus: "active" },
        });
      } catch (error) {
        await auditService.completeCritical(c, auditIntent, {
          status: "failure",
          metadata: {
            error: error instanceof Error ? error.message : "Unknown error",
          },
        });
        throw error;
      }
    } else {
      await auditService.log(c, {
        action: "create",
        resourceType: "token_allowlist",
        resourceId: entry.id,
        metadata: {
          tokenId,
          address: body.address,
          label: body.label,
          mode: "database",
          syncStatus: "not_required",
        },
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
  const parsed = removeAllowlistQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    throw badRequestQuery({ errors: z.treeifyError(parsed.error) });
  }

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

  const list = token.ablListAddress
    ? assertValidAddress(token.ablListAddress, "ablListAddress")
    : null;
  const authorityWallet = list
    ? await resolveAllowlistAuthoritySigner(
        c,
        auth,
        tokenService,
        list,
        parsed.data.signingCustodyWalletId
      )
    : null;
  const auditService = new AuditService(getDb(c.env));
  const auditIntent = await auditService.beginCritical(c, {
    action: "revoke",
    resourceType: "token_allowlist",
    resourceId: entryId,
    metadata: {
      tokenId,
      address: entry.address,
      mode: list ? "on-chain" : "database",
      custodyWalletId: authorityWallet?.custodyWalletId ?? null,
    },
  });
  let authoritativeEffectCompleted = false;

  try {
    // For on-chain lists, confirm authoritative removal before publishing the
    // final DB state. The helper reconciles ambiguous submission errors by
    // reading membership, so a timeout that landed still completes, while a
    // definite failure leaves the entry accurately active and safely retryable.
    if (list && authorityWallet) {
      await removeExistingAllowlistEntryOnChain({
        c,
        signer: authorityWallet.signer,
        list,
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
