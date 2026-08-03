import { assertValidAddress } from "@sdp/solana/address";
import type { TokenAllowlistEntry, TokenAllowlistResponse } from "@sdp/types";
import type { Context } from "hono";
import { z } from "zod";
import { getDb } from "@/db";
import { AppError, badRequest, badRequestQuery, notFound } from "@/lib/errors";
import { created, noContent, paginated, success } from "@/lib/response";
import { getLogger } from "@/runtime/logger";
import { AuditService } from "@/services/audit.service";
import { createOrgSigner } from "@/services/solana";
import type { TokenService } from "@/services/token.service";
import type { Env } from "@/types/env";
import {
  createIssuanceMosaicService,
  getTenantTokenService,
  requireProjectScope,
} from "../helpers";
import { addAllowlistSchema, listAllowlistQuerySchema } from "../schemas";

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

export const addAllowlistEntry = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const { auth, projectId, orgId } = requireProjectScope(c);

  const body = await c.req.json();
  const parsed = addAllowlistSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
    });
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

  try {
    let { entry } = await tokenService.addAllowlistEntry({
      tokenId,
      address: parsed.data.address,
      addedBy: auth.id,
      label: parsed.data.label,
      initialStatus: token.ablListAddress ? "pending" : "active",
    });

    const auditService = new AuditService(getDb(c.env));
    await auditService.log(c, {
      action: "create",
      resourceType: "token_allowlist",
      resourceId: entry.id,
      metadata: {
        tokenId,
        address: parsed.data.address,
        label: parsed.data.label,
        mode: token.ablListAddress ? "on-chain" : "database",
        syncStatus: token.ablListAddress ? "pending" : "not_required",
      },
    });

    if (token.ablListAddress) {
      entry = await syncNewAllowlistEntryOnChain({
        c,
        organizationId: auth.organizationId,
        projectId,
        signingWalletId: token.signingWalletId,
        tokenService,
        entryId: entry.id,
        list: assertValidAddress(token.ablListAddress, "ablListAddress"),
        wallet: assertValidAddress(parsed.data.address, "address"),
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

  // For on-chain lists, confirm authoritative removal before publishing the
  // final DB state. The helper reconciles ambiguous submission errors by
  // reading membership, so a timeout that landed still completes, while a
  // definite failure leaves the entry accurately active and safely retryable.
  if (token.ablListAddress) {
    await removeExistingAllowlistEntryOnChain({
      c,
      organizationId: auth.organizationId,
      projectId,
      signingWalletId: token.signingWalletId,
      list: assertValidAddress(token.ablListAddress, "ablListAddress"),
      wallet: assertValidAddress(entry.address, "address"),
    });
  }

  await tokenService.revokeAllowlistEntry(entryId);

  // Audit log
  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    action: "revoke",
    resourceType: "token_allowlist",
    resourceId: entryId,
    metadata: {
      tokenId,
      address: entry.address,
      mode: token.ablListAddress ? "on-chain" : "database",
    },
  });

  return noContent(c);
};
