import type { TokenAllowlistResponse } from "@sdp/types";
import type { Context } from "hono";
import { getDb } from "@/db";
import { getAuth } from "@/lib/auth";
import { AppError, notFound } from "@/lib/errors";
import { created, noContent, paginated } from "@/lib/response";
import { assertValidAddress } from "@/lib/solana";
import { AuditService } from "@/services/audit.service";
import { createMosaicService } from "@/services/mosaic";
import { createOrgSigner } from "@/services/solana";
import { TokenService } from "@/services/token.service";
import type { Env } from "@/types/env";
import { addAllowlistSchema } from "../schemas";

type AppContext = Context<{ Bindings: Env }>;

export const listAllowlist = async (c: AppContext) => {
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
  const auth = getAuth(c);

  const body = await c.req.json();
  const parsed = addAllowlistSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const tokenService = new TokenService(getDb(c.env));
  const token = await tokenService.getToken(tokenId);

  if (!token || token.organizationId !== auth?.organizationId) {
    throw notFound("Token");
  }

  if (auth?.projectId && token.projectId !== auth.projectId) {
    throw notFound("Token");
  }

  try {
    const entry = await tokenService.addAllowlistEntry({
      tokenId,
      address: parsed.data.address,
      addedBy: auth.id,
      label: parsed.data.label,
    });

    try {
      if (token.ablListAddress) {
        const signer = await createOrgSigner(
          c.env,
          auth.organizationId,
          auth.projectId,
          token.signingWalletId ?? undefined
        );
        const mosaic = createMosaicService(c.env, signer);
        await mosaic.addToList({
          list: assertValidAddress(token.ablListAddress, "ablListAddress"),
          authority: signer.address,
          feePayer: signer.address,
          wallet: assertValidAddress(parsed.data.address, "address"),
        });
      }
    } catch (error) {
      try {
        await tokenService.revokeAllowlistEntry(entry.id);
      } catch (revokeError) {
        throw new AppError(
          "INTERNAL_ERROR",
          "Failed to roll back control-list entry after sync error",
          {
            originalError: error instanceof Error ? error.message : "Unknown add error",
            restoreError:
              revokeError instanceof Error ? revokeError.message : "Unknown rollback error",
          }
        );
      }

      throw error;
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
  const auth = getAuth(c);

  const tokenService = new TokenService(getDb(c.env));
  const token = await tokenService.getToken(tokenId);

  if (!token || token.organizationId !== auth?.organizationId) {
    throw notFound("Token");
  }

  if (auth?.projectId && token.projectId !== auth.projectId) {
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
        authority: signer.address,
        feePayer: signer.address,
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
