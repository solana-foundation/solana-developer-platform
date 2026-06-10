import type { TokenResponse } from "@sdp/types";
import type { Address } from "@solana/kit";
import type { Context } from "hono";
import { z } from "zod";
import { getDb } from "@/db";
import { AppError, badRequest, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { resolveApiKeySigningWalletId } from "@/services/api-key-scope.service";
import { AuditService } from "@/services/audit.service";
import { createMosaicService } from "@/services/mosaic";
import { createOrgSigner } from "@/services/solana";
import { createRpc, simulateTransaction } from "@/services/solana/rpc";
import { TokenService } from "@/services/token.service";
import type { Env } from "@/types/env";
import { requireProjectScope } from "../helpers";
import { deployTokenSchema } from "../schemas";
import { getMosaicAclMode, shouldEnableOnChainAcl } from "./access-control";
import { getInitialPermanentDelegateAuthority } from "./authority-resolution";
import { buildIdempotencyMetadata } from "./idempotency";

type AppContext = Context<{ Bindings: Env }>;

export const deployToken = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const { auth, projectId, orgId } = requireProjectScope(c);
  const body = await c.req.json().catch(() => ({}));
  const parsed = deployTokenSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
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

  // Validate token is in pending status
  if (token.status !== "pending") {
    throw new AppError(
      "BAD_REQUEST",
      "Token has already been deployed or is not in pending status"
    );
  }

  if (token.mintAddress) {
    throw badRequest("Token already has a mint address");
  }

  const idempotencyMetadata = buildIdempotencyMetadata(c.req.header("Idempotency-Key"), {
    tokenId,
    operation: "deploy",
    mode: "execute",
    params: {
      token: {
        name: token.name,
        symbol: token.symbol,
        template: token.template,
      },
      status: token.status,
    },
  });

  const { transaction: tx, replayed } = await tokenService.createTransaction({
    tokenId,
    organizationId: auth.organizationId,
    type: "deploy",
    params: {
      operation: "deploy",
      tokenId,
      template: token.template,
      name: token.name,
      symbol: token.symbol,
    },
    initiatedByKeyId: auth.id,
    idempotencyKey: idempotencyMetadata.idempotencyKey,
    idempotencyFingerprint: idempotencyMetadata.idempotencyFingerprint,
  });

  if (replayed) {
    return success(c, { token });
  }

  const signingWalletId = resolveApiKeySigningWalletId(
    auth,
    parsed.data.signingWalletId ?? token.signingWalletId,
    ["tokens:write"]
  );

  // Deploy using Mosaic templates - handles ABL setup automatically
  const enableAbl = shouldEnableOnChainAcl(token);
  const aclMode = getMosaicAclMode(token);

  try {
    // Get custody signer (resolves via 3-tier: project → org → env fallback)
    const signer = await createOrgSigner(
      c.env,
      auth.organizationId,
      auth.projectId,
      signingWalletId
    );
    const custodyAddress = signer.address;

    // Create Mosaic service for template-based token deployment
    const mosaic = createMosaicService(c.env, signer);

    const result = await mosaic.createToken({
      template: token.template,
      metadata: {
        name: token.name,
        symbol: token.symbol,
        uri: token.uri ?? "",
      },
      decimals: token.decimals,
      mintAuthority: signer,
      freezeAuthority: token.isFreezable ? custodyAddress : null,
      feePayer: signer,
      extensions: token.extensions ?? undefined,
      enableAbl,
      aclMode,
    });

    const freezeAuthority = token.isFreezable ? custodyAddress : null;

    // Update token with deployment info (including ABL list if created)
    const deployedToken = await tokenService.setTokenDeployed(
      tokenId,
      result.mint as Address,
      custodyAddress,
      freezeAuthority,
      result.listAddress as Address | undefined
    );

    const initialPermanentDelegate = getInitialPermanentDelegateAuthority(token, custodyAddress);
    const updatedToken =
      initialPermanentDelegate !== undefined
        ? await tokenService.updateTokenAuthorities(tokenId, {
            permanentDelegate: initialPermanentDelegate,
          })
        : deployedToken;

    await tokenService.updateTransaction(tx.id, {
      status: "confirmed",
      signature: result.signature,
      slot: Number(result.slot),
      params: {
        operation: "deploy",
        mintAddress: result.mint,
        mintAuthority: custodyAddress,
        freezeAuthority: token.isFreezable ? custodyAddress : null,
        ablListAddress: result.listAddress,
        aclMode,
      },
    });

    // Audit log
    const auditService = new AuditService(getDb(c.env));
    await auditService.log(c, {
      action: "deploy",
      resourceType: "token",
      resourceId: tokenId,
      metadata: {
        mintAddress: result.mint,
        signature: result.signature,
        slot: result.slot.toString(),
        template: token.template,
        ablListAddress: result.listAddress,
        aclMode,
      },
    });

    const response: TokenResponse = { token: updatedToken };
    return success(c, response);
  } catch (error) {
    await tokenService.updateTransaction(tx.id, {
      status: "failed",
      error: error instanceof Error ? error.message : "Unknown error",
    });
    throw error;
  }
};

export const prepareDeploy = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const { auth, projectId, orgId } = requireProjectScope(c);
  const body = await c.req.json().catch(() => ({}));
  const parsed = deployTokenSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
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

  if (token.status !== "pending") {
    throw new AppError(
      "BAD_REQUEST",
      "Token has already been deployed or is not in pending status"
    );
  }

  if (token.mintAddress) {
    throw badRequest("Token already has a mint address");
  }

  const signingWalletId = resolveApiKeySigningWalletId(
    auth,
    parsed.data.signingWalletId ?? token.signingWalletId,
    ["tokens:write"]
  );

  // Get custody signer (resolves via 3-tier: project → org → env fallback)
  const signer = await createOrgSigner(c.env, auth.organizationId, auth.projectId, signingWalletId);
  const custodyAddress = signer.address;

  // Create Mosaic service and prepare transaction
  const mosaic = createMosaicService(c.env, signer);

  const enableAbl = shouldEnableOnChainAcl(token);
  const aclMode = getMosaicAclMode(token);

  const prepared = await mosaic.prepareCreateToken({
    template: token.template,
    metadata: {
      name: token.name,
      symbol: token.symbol,
      uri: token.uri ?? "",
    },
    decimals: token.decimals,
    mintAuthority: signer,
    freezeAuthority: token.isFreezable ? custodyAddress : null,
    feePayer: signer,
    extensions: token.extensions ?? undefined,
    enableAbl,
    aclMode,
  });

  const rpc = createRpc(c.env);
  const txBytes = Buffer.from(prepared.serializedTx, "base64");
  const simulation = await simulateTransaction(rpc, txBytes);

  // Audit log
  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    action: "deploy",
    resourceType: "token",
    resourceId: tokenId,
    metadata: {
      mode: "prepare",
      mint: prepared.mint,
      template: token.template,
      aclMode,
    },
  });

  return success(c, {
    transaction: {
      serialized: prepared.serializedTx,
      blockhash: prepared.blockhash,
      lastValidBlockHeight: prepared.lastValidBlockHeight.toString(),
    },
    mint: prepared.mint,
    listAddress: prepared.listAddress,
    simulation,
  });
};
