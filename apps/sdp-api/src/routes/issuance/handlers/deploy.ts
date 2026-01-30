import { getAuth } from "@/lib/auth";
import { AppError, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { AuditService } from "@/services/audit.service";
import { createMosaicService } from "@/services/mosaic";
import { createOrgSigner } from "@/services/solana";
import { createRpc, simulateTransaction } from "@/services/solana/rpc";
import { TokenService } from "@/services/token.service";
import type { Env } from "@/types/env";
import type { TokenResponse } from "@sdp/types";
import { TOKEN_ACL_PROGRAM_ID } from "@mosaic/sdk";
import type { Address } from "@solana/kit";
import type { Context } from "hono";

type AppContext = Context<{ Bindings: Env }>;

export const deployToken = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const auth = getAuth(c);

  const tokenService = new TokenService(c.env.DB);
  const token = await tokenService.getToken(tokenId);

  if (!token || token.organizationId !== auth?.organizationId) {
    throw notFound("Token");
  }

  if (auth?.projectId && token.projectId !== auth.projectId) {
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
    throw new AppError("BAD_REQUEST", "Token already has a mint address");
  }

  // Get custody signer (resolves via 3-tier: project → org → env fallback)
  const signer = await createOrgSigner(c.env, auth.organizationId, auth.projectId);
  const custodyAddress = signer.address;

  // Create Mosaic service for template-based token deployment
  const mosaic = createMosaicService(c.env, signer);

  // Deploy using Mosaic templates - handles ABL setup automatically
  const enableAbl = token.requiresAllowlist && c.env.SOLANA_NETWORK === "mainnet-beta";

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
    // Enable on-chain ABL for templates that require allowlist
    enableAbl,
  });

  const enableSrfc37 = enableAbl && token.isFreezable;
  const freezeAuthority = token.isFreezable
    ? enableSrfc37
      ? TOKEN_ACL_PROGRAM_ID
      : custodyAddress
    : null;

  // Update token with deployment info (including ABL list if created)
  const updatedToken = await tokenService.setTokenDeployed(
    tokenId,
    result.mint as Address,
    custodyAddress,
    freezeAuthority,
    result.listAddress as Address | undefined
  );

  // Create transaction record
  await tokenService.createTransaction({
    tokenId,
    organizationId: auth.organizationId,
    type: "mint", // Using "mint" as deploy type for the transaction log
    params: {
      operation: "deploy",
      mintAddress: result.mint,
      mintAuthority: custodyAddress,
      freezeAuthority: token.isFreezable ? custodyAddress : null,
      ablListAddress: result.listAddress,
      template: token.template,
    },
    initiatedByKeyId: auth.id,
  });

  // Audit log
  const auditService = new AuditService(c.env.DB);
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
    },
  });

  const response: TokenResponse = { token: updatedToken };
  return success(c, response);
};

export const prepareDeploy = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const auth = getAuth(c);

  const tokenService = new TokenService(c.env.DB);
  const token = await tokenService.getToken(tokenId);

  if (!token || token.organizationId !== auth?.organizationId) {
    throw notFound("Token");
  }

  if (auth?.projectId && token.projectId !== auth.projectId) {
    throw notFound("Token");
  }

  if (token.status !== "pending") {
    throw new AppError(
      "BAD_REQUEST",
      "Token has already been deployed or is not in pending status"
    );
  }

  if (token.mintAddress) {
    throw new AppError("BAD_REQUEST", "Token already has a mint address");
  }

  // Get custody signer (resolves via 3-tier: project → org → env fallback)
  const signer = await createOrgSigner(c.env, auth.organizationId, auth.projectId);
  const custodyAddress = signer.address;

  // Create Mosaic service and prepare transaction
  const mosaic = createMosaicService(c.env, signer);

  const enableAbl = token.requiresAllowlist && c.env.SOLANA_NETWORK === "mainnet-beta";

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
  });

  const rpc = createRpc(c.env);
  const txBytes = Buffer.from(prepared.serializedTx, "base64");
  const simulation = await simulateTransaction(rpc, txBytes);

  // Audit log
  const auditService = new AuditService(c.env.DB);
  await auditService.log(c, {
    action: "deploy",
    resourceType: "token",
    resourceId: tokenId,
    metadata: {
      mode: "prepare",
      mint: prepared.mint,
      template: token.template,
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
