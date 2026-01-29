import { getAuth } from "@/lib/auth";
import { AppError, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { AuditService } from "@/services/audit.service";
import { createSigner, createToken2022Service } from "@/services/solana";
import { TokenService } from "@/services/token.service";
import type { Env } from "@/types/env";
import type { TokenResponse } from "@sdp/types";
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

  // Get custody signer
  const signer = await createSigner(c.env);
  const custodyAddress = signer.address;

  // Create Token-2022 service and deploy (uses Kora for fee payment if configured)
  const token2022 = createToken2022Service(c.env);

  const result = await token2022.createMint({
    decimals: token.decimals,
    mintAuthority: custodyAddress,
    freezeAuthority: token.isFreezable ? custodyAddress : null,
    extensions: token.extensions ?? undefined,
  });

  // Update token with deployment info
  const updatedToken = await tokenService.setTokenDeployed(
    tokenId,
    result.mint,
    custodyAddress,
    token.isFreezable ? custodyAddress : null
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

  // Get custody signer for fee payer
  const signer = await createSigner(c.env);
  const custodyAddress = signer.address;

  // Create Token-2022 service and prepare transaction
  const token2022 = createToken2022Service(c.env);

  const prepared = await token2022.prepareCreateMint(
    {
      decimals: token.decimals,
      mintAuthority: custodyAddress,
      freezeAuthority: token.isFreezable ? custodyAddress : null,
      extensions: token.extensions ?? undefined,
    },
    true // Request simulation
  );

  // Audit log
  const auditService = new AuditService(c.env.DB);
  await auditService.log(c, {
    action: "deploy",
    resourceType: "token",
    resourceId: tokenId,
    metadata: {
      mode: "prepare",
      mint: prepared.mint,
    },
  });

  return success(c, {
    transaction: {
      serialized: prepared.serializedTx,
      blockhash: prepared.blockhash,
      lastValidBlockHeight: prepared.lastValidBlockHeight.toString(),
    },
    mint: prepared.mint,
    simulation: prepared.simulation,
  });
};
