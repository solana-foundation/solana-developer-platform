import { toMosaicAmount } from "@/lib/amount";
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
import type { Context } from "hono";
import { seizeSchema } from "../schemas";

type AppContext = Context<{ Bindings: Env }>;
type TokenRecord = Awaited<ReturnType<TokenService["getToken"]>>;

const resolvePermanentDelegate = (token: TokenRecord): string | null => {
  if (!token) {
    return null;
  }
  return token.extensions?.permanentDelegate ?? token.mintAuthority;
};

export const prepareSeize = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const auth = getAuth(c);

  const body = await c.req.json();
  const parsed = seizeSchema.safeParse(body);

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

  if (token.status !== "active") {
    throw new AppError("TOKEN_NOT_ACTIVE", "Token must be active to seize");
  }

  if (!token.mintAddress) {
    throw new AppError("TOKEN_NOT_DEPLOYED", "Token has not been deployed to Solana");
  }

  if (token.requiresAllowlist) {
    const isAllowed = await tokenService.isAddressAllowed(tokenId, parsed.data.seize.destination);
    if (!isAllowed) {
      throw new AppError("NOT_ON_TOKEN_ALLOWLIST", "Destination address is not on the allowlist");
    }
  }

  const permanentDelegateRaw =
    parsed.data.seize.delegateAuthority ?? resolvePermanentDelegate(token);
  if (!permanentDelegateRaw) {
    throw new AppError("BAD_REQUEST", "Permanent delegate is not configured for this token");
  }

  const signer = await createOrgSigner(c.env, auth.organizationId, auth.projectId);
  const mintAddress = assertValidAddress(token.mintAddress, "mintAddress");
  const source = assertValidAddress(parsed.data.seize.source, "source");
  const destination = assertValidAddress(parsed.data.seize.destination, "destination");
  // biome-ignore lint/nursery/noSecrets: Field label used for error messages, not a secret.
  const permanentDelegate = assertValidAddress(permanentDelegateRaw, "delegateAuthority");

  const mosaic = createMosaicService(c.env, signer);
  const prepared = await mosaic.prepareForceTransfer({
    mint: mintAddress,
    source,
    destination,
    amount: toMosaicAmount(parsed.data.seize.amount, token.decimals),
    permanentDelegate,
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
    type: "seize",
    params: {
      source: parsed.data.seize.source,
      destination: parsed.data.seize.destination,
      amount: parsed.data.seize.amount,
      delegateAuthority: permanentDelegateRaw,
      memo: parsed.data.seize.memo,
    },
    serializedTx: prepared.serializedTx,
    initiatedByKeyId: auth.id,
  });

  const auditService = new AuditService(c.env.DB);
  await auditService.log(c, {
    action: "seize",
    resourceType: "token_transaction",
    resourceId: tx.id,
    metadata: {
      tokenId,
      source: parsed.data.seize.source,
      destination: parsed.data.seize.destination,
      amount: parsed.data.seize.amount,
      delegateAuthority: permanentDelegateRaw,
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

export const executeSeize = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const auth = getAuth(c);

  const body = await c.req.json();
  const parsed = seizeSchema.safeParse(body);

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

  if (token.status !== "active") {
    throw new AppError("TOKEN_NOT_ACTIVE", "Token must be active to seize");
  }

  if (!token.mintAddress) {
    throw new AppError("TOKEN_NOT_DEPLOYED", "Token has not been deployed to Solana");
  }

  if (token.requiresAllowlist) {
    const isAllowed = await tokenService.isAddressAllowed(tokenId, parsed.data.seize.destination);
    if (!isAllowed) {
      throw new AppError("NOT_ON_TOKEN_ALLOWLIST", "Destination address is not on the allowlist");
    }
  }

  const permanentDelegateRaw =
    parsed.data.seize.delegateAuthority ?? resolvePermanentDelegate(token);
  if (!permanentDelegateRaw) {
    throw new AppError("BAD_REQUEST", "Permanent delegate is not configured for this token");
  }

  const signer = await createOrgSigner(c.env, auth.organizationId, auth.projectId);
  if (permanentDelegateRaw !== signer.address) {
    throw new AppError("BAD_REQUEST", "Permanent delegate is not controlled by custody");
  }

  const mintAddress = assertValidAddress(token.mintAddress, "mintAddress");
  const source = assertValidAddress(parsed.data.seize.source, "source");
  const destination = assertValidAddress(parsed.data.seize.destination, "destination");

  const tx = await tokenService.createTransaction({
    tokenId,
    organizationId: auth.organizationId,
    type: "seize",
    params: {
      source: parsed.data.seize.source,
      destination: parsed.data.seize.destination,
      amount: parsed.data.seize.amount,
      delegateAuthority: permanentDelegateRaw,
      memo: parsed.data.seize.memo,
    },
    initiatedByKeyId: auth.id,
  });

  const mosaic = createMosaicService(c.env, signer);

  try {
    const result = await mosaic.forceTransfer({
      mint: mintAddress,
      source,
      destination,
      amount: toMosaicAmount(parsed.data.seize.amount, token.decimals),
      permanentDelegate: signer,
      feePayer: signer,
    });

    const updatedTx = await tokenService.updateTransaction(tx.id, {
      status: "confirmed",
      signature: result.signature,
      slot: Number(result.slot),
    });

    const auditService = new AuditService(c.env.DB);
    await auditService.log(c, {
      action: "seize",
      resourceType: "token_transaction",
      resourceId: tx.id,
      metadata: {
        tokenId,
        source: parsed.data.seize.source,
        destination: parsed.data.seize.destination,
        amount: parsed.data.seize.amount,
        delegateAuthority: permanentDelegateRaw,
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
