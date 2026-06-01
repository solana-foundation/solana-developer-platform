import type { TokenAllowlistResponse } from "@sdp/types";
import type { Context } from "hono";
import { getDb } from "@/db";
import { AppError, notFound } from "@/lib/errors";
import { created, noContent, paginated } from "@/lib/response";
import { assertValidAddress } from "@/lib/solana";
import { AuditService } from "@/services/audit.service";
import { createMosaicService } from "@/services/mosaic";
import { createOrgSigner } from "@/services/solana";
import { TokenService } from "@/services/token.service";
import type { Env } from "@/types/env";
import { requireProjectScope } from "../helpers";
import { addAllowlistSchema } from "../schemas";

type AppContext = Context<{ Bindings: Env }>;

/**
 * On-chain add for an allowlist row that was just inserted or reactivated,
 * with TOCTOU-safe rollback.
 *
 * If `addToList` errors, re-checks `isWalletOnList`. When membership is
 * confirmed, the DB row is kept and success bubbles up — the RPC/confirmation
 * error was transient and the on-chain write actually landed. Otherwise the
 * rollback path depends on `wasReactivated`:
 *
 *  - `false` (freshly inserted): hard-delete the row. Soft-revoking would
 *    leave a tombstone that the mint auto-add guard treats as an operator
 *    revoke and would block every subsequent mint to the address.
 *  - `true` (reactivated from `revoked`): re-revoke to restore the operator's
 *    prior revocation record. Hard-deleting would erase the original status
 *    history (the same row was operator-revoked earlier for KYC/compliance).
 */
async function syncNewAllowlistEntryOnChain(opts: {
  c: AppContext;
  organizationId: string;
  projectId: string;
  signingWalletId: string | null | undefined;
  tokenService: TokenService;
  entryId: string;
  wasReactivated: boolean;
  list: ReturnType<typeof assertValidAddress>;
  wallet: ReturnType<typeof assertValidAddress>;
}): Promise<void> {
  const signer = await createOrgSigner(
    opts.c.env,
    opts.organizationId,
    opts.projectId,
    opts.signingWalletId ?? undefined
  );
  const mosaic = createMosaicService(opts.c.env, signer);

  try {
    await mosaic.addToList({ list: opts.list, wallet: opts.wallet });
  } catch (error) {
    if (await mosaic.isWalletOnList(opts.list, opts.wallet)) {
      return;
    }
    try {
      if (opts.wasReactivated) {
        await opts.tokenService.revokeAllowlistEntry(opts.entryId);
      } else {
        await opts.tokenService.deleteAllowlistEntry(opts.entryId);
      }
    } catch (rollbackError) {
      throw new AppError(
        "INTERNAL_ERROR",
        "Failed to roll back control-list entry after sync error",
        {
          originalError: error instanceof Error ? error.message : "Unknown add error",
          restoreError:
            rollbackError instanceof Error ? rollbackError.message : "Unknown rollback error",
        }
      );
    }
    throw error;
  }
}

export const listAllowlist = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const { projectId, orgId } = requireProjectScope(c);

  const tokenService = new TokenService(getDb(c.env));
  const token = await tokenService.getToken({
    tokenId,
    organizationId: orgId,
    projectId,
  });

  if (!token) {
    throw notFound("Token");
  }

  const page = Number.parseInt(c.req.query("page") ?? "1", 10);
  const pageSize = Math.min(Number.parseInt(c.req.query("pageSize") ?? "50", 10), 100);
  const offset = (page - 1) * pageSize;

  const { entries, total } = await tokenService.listAllowlistEntries(tokenId, {
    limit: pageSize,
    offset,
  });

  return paginated(c, entries, { total, page, pageSize });
};

export const addAllowlistEntry = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const { auth, projectId, orgId } = requireProjectScope(c);

  const body = await c.req.json();
  const parsed = addAllowlistSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const tokenService = new TokenService(getDb(c.env));
  const token = await tokenService.getToken({
    tokenId,
    organizationId: orgId,
    projectId,
  });

  if (!token) {
    throw notFound("Token");
  }

  try {
    const { entry, wasReactivated } = await tokenService.addAllowlistEntry({
      tokenId,
      address: parsed.data.address,
      addedBy: auth.id,
      label: parsed.data.label,
    });

    if (token.ablListAddress) {
      await syncNewAllowlistEntryOnChain({
        c,
        organizationId: auth.organizationId,
        projectId,
        signingWalletId: token.signingWalletId,
        tokenService,
        entryId: entry.id,
        wasReactivated,
        list: assertValidAddress(token.ablListAddress, "ablListAddress"),
        wallet: assertValidAddress(parsed.data.address, "address"),
      });
    }

    // Audit log
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
      },
    });

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

  const tokenService = new TokenService(getDb(c.env));
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

  await tokenService.revokeAllowlistEntry(entryId);

  try {
    if (token.ablListAddress) {
      const signer = await createOrgSigner(
        c.env,
        auth.organizationId,
        auth.projectId,
        token.signingWalletId ?? undefined
      );
      const mosaic = createMosaicService(c.env, signer);
      await mosaic.removeFromList({
        list: assertValidAddress(token.ablListAddress, "ablListAddress"),
        wallet: assertValidAddress(entry.address, "address"),
      });
    }
  } catch (error) {
    try {
      await tokenService.addAllowlistEntry({
        tokenId,
        address: entry.address,
        addedBy: entry.addedBy,
        label: entry.label ?? undefined,
      });
    } catch (restoreError) {
      throw new AppError(
        "INTERNAL_ERROR",
        "Failed to restore control-list entry after sync error",
        {
          originalError: error instanceof Error ? error.message : "Unknown removal error",
          restoreError:
            restoreError instanceof Error ? restoreError.message : "Unknown restore error",
        }
      );
    }

    throw error;
  }

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
