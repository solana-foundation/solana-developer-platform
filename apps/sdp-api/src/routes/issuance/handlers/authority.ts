import { getAuth } from "@/lib/auth";
import { AppError, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { assertValidAddress } from "@/lib/solana";
import { AuditService } from "@/services/audit.service";
import { createMosaicService } from "@/services/mosaic";
import { createOrgSigner } from "@/services/solana";
import { createRpc, simulateTransaction } from "@/services/solana/rpc";
import { TokenService } from "@/services/token.service";
import type { Env } from "@/types/env";
import { AuthorityType } from "@solana-program/token-2022";
import type { Context } from "hono";
import { updateAuthoritySchema } from "../schemas";

type AppContext = Context<{ Bindings: Env }>;

type AuthorityRole = "mint" | "freeze" | "permanentDelegate" | "metadata";
type TokenRecord = Awaited<ReturnType<TokenService["getToken"]>>;

type AuthorityUpdate = {
  mintAuthority?: string | null;
  isMintable?: boolean;
  freezeAuthority?: string | null;
  isFreezable?: boolean;
  permanentDelegate?: string | null;
};

const mapAuthorityRole = (role: AuthorityRole): AuthorityType | "Metadata" => {
  switch (role) {
    case "mint":
      return AuthorityType.MintTokens;
    case "freeze":
      return AuthorityType.FreezeAccount;
    case "permanentDelegate":
      return AuthorityType.PermanentDelegate;
    case "metadata":
      return "Metadata";
  }
};

const resolveCurrentAuthority = (
  token: TokenRecord,
  role: AuthorityRole,
  override?: string
): string | null => {
  if (!token) {
    return null;
  }

  if (override) {
    return override;
  }

  switch (role) {
    case "mint":
      return token.mintAuthority;
    case "freeze":
      return token.freezeAuthority;
    case "permanentDelegate":
      return token.extensions?.permanentDelegate ?? token.mintAuthority;
    case "metadata":
      return token.mintAuthority;
  }
};

export const prepareUpdateAuthority = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const auth = getAuth(c);

  const body = await c.req.json();
  const parsed = updateAuthoritySchema.safeParse(body);

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

  if (!token.mintAddress || token.status === "pending") {
    throw new AppError("TOKEN_NOT_DEPLOYED", "Token has not been deployed to Solana");
  }

  const role = parsed.data.authority.role;
  const currentAuthorityRaw = resolveCurrentAuthority(
    token,
    role,
    parsed.data.authority.currentAuthority
  );

  if (!currentAuthorityRaw) {
    throw new AppError("BAD_REQUEST", "Current authority is not available for this token");
  }

  const mintAddress = assertValidAddress(token.mintAddress, "mintAddress");
  const currentAuthority = assertValidAddress(currentAuthorityRaw, "currentAuthority");
  const newAuthority = parsed.data.authority.newAuthority
    ? assertValidAddress(parsed.data.authority.newAuthority, "newAuthority")
    : null;

  const signer = await createOrgSigner(
    c.env,
    auth.organizationId,
    auth.projectId,
    auth.signingWalletId
  );
  const mosaic = createMosaicService(c.env, signer);

  const prepared = await mosaic.prepareUpdateAuthority({
    mint: mintAddress,
    role: mapAuthorityRole(role),
    currentAuthority,
    newAuthority,
    feePayer: signer.address,
  });

  let simulation: unknown;
  if (parsed.data.options?.simulate) {
    const rpc = createRpc(c.env);
    const txBytes = Buffer.from(prepared.serializedTx, "base64");
    simulation = await simulateTransaction(rpc, txBytes);
  }

  const tx = await tokenService.createTransaction({
    tokenId,
    organizationId: auth.organizationId,
    type: "update_authority",
    params: {
      role,
      currentAuthority,
      newAuthority,
    },
    serializedTx: prepared.serializedTx,
    initiatedByKeyId: auth.id,
  });

  const auditService = new AuditService(c.env.DB);
  await auditService.log(c, {
    action: "update_authority",
    resourceType: "token_transaction",
    resourceId: tx.id,
    metadata: {
      tokenId,
      role,
      currentAuthority,
      newAuthority,
      mode: "prepare",
    },
  });

  return success(c, {
    transaction: tx,
    preparedTransaction: {
      serialized: prepared.serializedTx,
      blockhash: prepared.blockhash,
      lastValidBlockHeight: prepared.lastValidBlockHeight.toString(),
    },
    simulation,
  });
};

export const executeUpdateAuthority = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const auth = getAuth(c);

  const body = await c.req.json();
  const parsed = updateAuthoritySchema.safeParse(body);

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

  if (!token.mintAddress || token.status === "pending") {
    throw new AppError("TOKEN_NOT_DEPLOYED", "Token has not been deployed to Solana");
  }

  const role = parsed.data.authority.role;
  const currentAuthorityRaw = resolveCurrentAuthority(
    token,
    role,
    parsed.data.authority.currentAuthority
  );

  if (!currentAuthorityRaw) {
    throw new AppError("BAD_REQUEST", "Current authority is not available for this token");
  }

  const signer = await createOrgSigner(
    c.env,
    auth.organizationId,
    auth.projectId,
    auth.signingWalletId
  );
  if (currentAuthorityRaw !== signer.address) {
    throw new AppError("BAD_REQUEST", "Current authority is not controlled by custody");
  }

  const mintAddress = assertValidAddress(token.mintAddress, "mintAddress");
  const newAuthority = parsed.data.authority.newAuthority
    ? assertValidAddress(parsed.data.authority.newAuthority, "newAuthority")
    : null;

  const tx = await tokenService.createTransaction({
    tokenId,
    organizationId: auth.organizationId,
    type: "update_authority",
    params: {
      role,
      currentAuthority: currentAuthorityRaw,
      newAuthority,
    },
    initiatedByKeyId: auth.id,
  });

  const mosaic = createMosaicService(c.env, signer);

  try {
    const result = await mosaic.updateAuthority({
      mint: mintAddress,
      role: mapAuthorityRole(role),
      currentAuthority: signer,
      newAuthority,
      feePayer: signer,
    });

    const updatedTx = await tokenService.updateTransaction(tx.id, {
      status: "confirmed",
      signature: result.signature,
      slot: Number(result.slot),
    });

    const updates: AuthorityUpdate = {};
    if (role === "mint") {
      updates.mintAuthority = newAuthority;
      updates.isMintable = newAuthority !== null;
    }
    if (role === "freeze") {
      updates.freezeAuthority = newAuthority;
      updates.isFreezable = newAuthority !== null;
    }
    if (role === "permanentDelegate") {
      updates.permanentDelegate = newAuthority;
    }

    if (Object.keys(updates).length > 0) {
      await tokenService.updateTokenAuthorities(tokenId, updates);
    }

    const auditService = new AuditService(c.env.DB);
    await auditService.log(c, {
      action: "update_authority",
      resourceType: "token_transaction",
      resourceId: tx.id,
      metadata: {
        tokenId,
        role,
        newAuthority,
        signature: result.signature,
        slot: result.slot.toString(),
        mode: "execute",
      },
    });

    return success(c, { transaction: updatedTx });
  } catch (error) {
    await tokenService.updateTransaction(tx.id, {
      status: "failed",
      error: error instanceof Error ? error.message : "Unknown error",
    });
    throw error;
  }
};
