import { getAuth } from "@/lib/auth";
import { AppError, notFound } from "@/lib/errors";
import { created, success } from "@/lib/response";
import { assertValidAddress } from "@/lib/solana";
import { AuditService } from "@/services/audit.service";
import { createSigner, createToken2022Service } from "@/services/solana";
import { TokenService } from "@/services/token.service";
import type { Env } from "@/types/env";
import type { FrozenAccountResponse } from "@sdp/types";
import type { Context } from "hono";
import { freezeSchema, unfreezeSchema } from "../schemas";

type AppContext = Context<{ Bindings: Env }>;

export const freezeAccount = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const auth = getAuth(c);

  const body = await c.req.json();
  const parsed = freezeSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const tokenService = new TokenService(c.env.DB);
  const token = await tokenService.getToken(tokenId);

  if (!token || token.organizationId !== auth?.organizationId) {
    throw notFound("Token");
  }

  if (auth?.projectId && token.projectId !== auth.projectId) {
    throw notFound("Token");
  }

  if (!token.isFreezable) {
    throw new AppError("BAD_REQUEST", "Token does not support freezing");
  }

  if (!token.mintAddress) {
    throw new AppError("TOKEN_NOT_DEPLOYED", "Token has not been deployed to Solana");
  }

  // Get custody signer (freeze authority)
  const signer = await createSigner(c.env);
  const mintAddress = assertValidAddress(token.mintAddress, "mintAddress");
  const accountAddress = assertValidAddress(parsed.data.accountAddress, "accountAddress");

  // Execute freeze on Solana first
  const token2022 = createToken2022Service(c.env);

  try {
    const result = await token2022.freezeAccount({
      mint: mintAddress,
      account: accountAddress,
      freezeAuthority: signer,
    });

    // Record in database after successful on-chain operation
    const frozenAccount = await tokenService.freezeAccount({
      tokenId,
      accountAddress: parsed.data.accountAddress,
      frozenBy: auth.id,
      reason: parsed.data.reason,
    });

    // Create transaction record for the freeze operation
    await tokenService.createTransaction({
      tokenId,
      organizationId: auth.organizationId,
      type: "freeze",
      params: {
        accountAddress: parsed.data.accountAddress,
        reason: parsed.data.reason,
        signature: result.signature,
        slot: result.slot.toString(),
      },
      initiatedByKeyId: auth.id,
    });

    // Audit log
    const auditService = new AuditService(c.env.DB);
    await auditService.log(c, {
      action: "freeze",
      resourceType: "frozen_account",
      resourceId: frozenAccount.id,
      metadata: {
        tokenId,
        accountAddress: parsed.data.accountAddress,
        reason: parsed.data.reason,
        signature: result.signature,
        slot: result.slot.toString(),
      },
    });

    const response: FrozenAccountResponse = { frozenAccount };
    return created(c, response);
  } catch (error) {
    if (error instanceof Error && error.message === "ACCOUNT_ALREADY_FROZEN") {
      throw new AppError("ACCOUNT_FROZEN", "Account is already frozen");
    }
    throw error;
  }
};

export const unfreezeAccount = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const auth = getAuth(c);

  const body = await c.req.json();
  const parsed = unfreezeSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const tokenService = new TokenService(c.env.DB);
  const token = await tokenService.getToken(tokenId);

  if (!token || token.organizationId !== auth?.organizationId) {
    throw notFound("Token");
  }

  if (auth?.projectId && token.projectId !== auth.projectId) {
    throw notFound("Token");
  }

  if (!token.mintAddress) {
    throw new AppError("TOKEN_NOT_DEPLOYED", "Token has not been deployed to Solana");
  }

  // Get custody signer (freeze authority)
  const signer = await createSigner(c.env);
  const mintAddress = assertValidAddress(token.mintAddress, "mintAddress");
  const accountAddress = assertValidAddress(parsed.data.accountAddress, "accountAddress");

  // Execute thaw on Solana first
  const token2022 = createToken2022Service(c.env);

  try {
    const result = await token2022.thawAccount({
      mint: mintAddress,
      account: accountAddress,
      freezeAuthority: signer,
    });

    // Update database record after successful on-chain operation
    const frozenAccount = await tokenService.unfreezeAccount(
      tokenId,
      parsed.data.accountAddress,
      auth.id
    );

    // Create transaction record for the unfreeze operation
    await tokenService.createTransaction({
      tokenId,
      organizationId: auth.organizationId,
      type: "unfreeze",
      params: {
        accountAddress: parsed.data.accountAddress,
        signature: result.signature,
        slot: result.slot.toString(),
      },
      initiatedByKeyId: auth.id,
    });

    // Audit log
    const auditService = new AuditService(c.env.DB);
    await auditService.log(c, {
      action: "unfreeze",
      resourceType: "frozen_account",
      resourceId: frozenAccount.id,
      metadata: {
        tokenId,
        accountAddress: parsed.data.accountAddress,
        signature: result.signature,
        slot: result.slot.toString(),
      },
    });

    const response: FrozenAccountResponse = { frozenAccount };
    return success(c, response);
  } catch (error) {
    if (error instanceof Error && error.message === "ACCOUNT_NOT_FROZEN") {
      throw new AppError("ACCOUNT_NOT_FROZEN", "Account is not frozen");
    }
    throw error;
  }
};
