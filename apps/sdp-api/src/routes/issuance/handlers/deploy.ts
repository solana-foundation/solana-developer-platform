import type { TokenResponse } from "@sdp/types";
import type { Address } from "@solana/kit";
import type { Context } from "hono";
import { z } from "zod";
import { getDb } from "@/db";
import { AppError, badRequest, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { resolveApiKeySigningWalletId } from "@/services/api-key-scope.service";
import { AuditService } from "@/services/audit.service";
import { createMosaicService, MintMetadataUpdateError, PACKET_DATA_SIZE } from "@/services/mosaic";
import { createOrgSigner } from "@/services/solana";
import { createRpc, simulateTransaction } from "@/services/solana/rpc";
import { TokenService } from "@/services/token.service";
import type { Env } from "@/types/env";
import { requireProjectScope } from "../helpers";
import { deployTokenSchema } from "../schemas";
import { getMosaicAclMode, shouldEnableOnChainAcl } from "./access-control";
import { getInitialPermanentDelegateAuthority } from "./authority-resolution";
import { buildIdempotencyMetadata } from "./idempotency";
import { canonicalMetadataUrl, resolveMetadataOrigin } from "./metadata";

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

  // Hoisted so the catch block can persist the mint authority if createToken
  // fails after the mint is already live on-chain (see MintMetadataUpdateError).
  let custodyAddress: Address | undefined;

  try {
    // Get custody signer (resolves via 3-tier: project → org → env fallback)
    const signer = await createOrgSigner(
      c.env,
      auth.organizationId,
      auth.projectId,
      signingWalletId
    );
    custodyAddress = signer.address;

    // Create Mosaic service for template-based token deployment
    const mosaic = createMosaicService(c.env, signer);

    const result = await mosaic.createToken({
      template: token.template,
      metadata: {
        name: token.name,
        symbol: token.symbol,
        // Fall back to the SDP-hosted metadata JSON when the issuer didn't
        // supply their own URI (HOO-466). Origin resolves to PUBLIC_API_ORIGIN
        // when set, else the request origin, so the on-chain MetadataPointer
        // points each environment at itself.
        uri:
          token.uri?.trim() ||
          canonicalMetadataUrl(resolveMetadataOrigin(c.env, c.req.url), token.id),
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
    // The mint was created on-chain but the metadata-URI follow-up failed. The
    // create is irreversible, so record the mint (marking the token active)
    // before surfacing the error — otherwise a retry generates a new keypair
    // and mints a second, orphaned token. The hosted-URI pointer is left unset;
    // it can be fixed later via a metadata update.
    if (error instanceof MintMetadataUpdateError && custodyAddress && error.result.mint) {
      const freezeAuthority = token.isFreezable ? custodyAddress : null;
      await tokenService.setTokenDeployed(
        tokenId,
        error.result.mint,
        custodyAddress,
        freezeAuthority,
        error.result.listAddress as string | undefined
      );
      await tokenService.updateTransaction(tx.id, {
        status: "confirmed",
        signature: error.result.signature,
        slot: Number(error.result.slot),
        params: {
          operation: "deploy",
          mintAddress: error.result.mint,
          mintAuthority: custodyAddress,
          freezeAuthority,
          ablListAddress: error.result.listAddress,
          aclMode,
          metadataUriFailed: true,
        },
      });

      throw new AppError(
        "TRANSACTION_FAILED",
        "Token mint was created on-chain, but setting its metadata URI failed. " +
          "The mint is recorded — do not redeploy; set the metadata URI via a follow-up update.",
        { mintAddress: error.result.mint }
      );
    }

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

  // See deployToken above: SDP-hosted metadata fallback (HOO-466).
  const resolvedUri =
    token.uri?.trim() || canonicalMetadataUrl(resolveMetadataOrigin(c.env, c.req.url), token.id);

  const buildMetadata = (uri: string) => ({ name: token.name, symbol: token.symbol, uri });
  const prepareOptions = {
    template: token.template,
    decimals: token.decimals,
    mintAuthority: signer,
    freezeAuthority: token.isFreezable ? custodyAddress : null,
    feePayer: signer,
    extensions: token.extensions ?? undefined,
    enableAbl,
    aclMode,
  };

  let prepared = await mosaic.prepareCreateToken({
    ...prepareOptions,
    metadata: buildMetadata(resolvedUri),
  });

  // The client signs and submits this tx itself, so the server can't set the
  // uri afterward (the client owns the update authority). When the inline uri
  // pushes the create tx over the packet limit (heavy template + long hosted
  // URL), re-prepare the create tx with an empty uri and signal that the client
  // must set the real uri in a follow-up tx (POST .../deploy/prepare-metadata)
  // after the create tx confirms. Lighter templates / short URIs keep the
  // single-tx fast path.
  let metadataUriFollowUp: { required: true; uri: string } | undefined;
  if (Buffer.from(prepared.serializedTx, "base64").length > PACKET_DATA_SIZE) {
    prepared = await mosaic.prepareCreateToken({
      ...prepareOptions,
      metadata: buildMetadata(""),
    });
    metadataUriFollowUp = { required: true, uri: resolvedUri };
  }

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
      metadataUriFollowUp: metadataUriFollowUp?.required ?? false,
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
    ...(metadataUriFollowUp ? { metadataUriFollowUp } : {}),
  });
};

/**
 * Prepare the metadata-uri follow-up transaction for the non-custodial,
 * client-signed deploy flow (HOO-466).
 *
 * Two-tx contract: when `prepareDeploy` returns `metadataUriFollowUp.required`,
 * the client signs+sends the create tx, confirms it, then calls THIS endpoint
 * to fetch an unsigned metadata field-update tx (set with a fresh blockhash —
 * the mint's metadata account only exists once the create tx confirms), signs
 * it with its update authority, and submits it. The update authority is the
 * same signing wallet used for the create tx, so no server key is involved.
 */
export const prepareDeployMetadata = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const { auth, projectId, orgId } = requireProjectScope(c);
  const body = await c.req.json().catch(() => ({}));
  const parsed = deployTokenSchema.safeParse(body);

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

  if (!token.mintAddress) {
    throw new AppError("BAD_REQUEST", "Token has not been deployed yet");
  }

  const signingWalletId = resolveApiKeySigningWalletId(
    auth,
    parsed.data.signingWalletId ?? token.signingWalletId,
    ["tokens:write"]
  );

  const signer = await createOrgSigner(c.env, auth.organizationId, auth.projectId, signingWalletId);
  const mosaic = createMosaicService(c.env, signer);

  // Resolve the same uri prepareDeploy used so the on-chain pointer ends up at
  // the SDP-hosted (or issuer-supplied) URL.
  const resolvedUri =
    token.uri?.trim() || canonicalMetadataUrl(resolveMetadataOrigin(c.env, c.req.url), token.id);

  const prepared = await mosaic.prepareUpdateMetadata({
    mint: token.mintAddress as Address,
    uri: resolvedUri,
    updateAuthority: signer,
    feePayer: signer,
  });

  // On-chain uri already matches (e.g. the create tx fit and carried it
  // inline). Nothing for the client to sign.
  if (!prepared) {
    return success(c, { transaction: null, uri: resolvedUri });
  }

  const rpc = createRpc(c.env);
  const simulation = await simulateTransaction(rpc, Buffer.from(prepared.serializedTx, "base64"));

  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    action: "deploy",
    resourceType: "token",
    resourceId: tokenId,
    metadata: {
      mode: "prepare-metadata",
      mint: token.mintAddress,
      template: token.template,
    },
  });

  return success(c, {
    transaction: {
      serialized: prepared.serializedTx,
      blockhash: prepared.blockhash,
      lastValidBlockHeight: prepared.lastValidBlockHeight.toString(),
    },
    uri: resolvedUri,
    simulation,
  });
};
