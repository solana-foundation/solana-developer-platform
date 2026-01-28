import { getAuth } from "@/lib/auth";
import { AppError, notFound } from "@/lib/errors";
import { created, paginated, success } from "@/lib/response";
import { AuditService } from "@/services/audit.service";
import { TokenService } from "@/services/token.service";
import type { Env } from "@/types/env";
import type { TokenResponse } from "@sdp/types";
import type { Context } from "hono";
import { requireProjectScope } from "../helpers";
import { createTokenSchema, updateTokenSchema } from "../schemas";

type AppContext = Context<{ Bindings: Env }>;

export const createToken = async (c: AppContext) => {
  const { auth, projectId, orgId } = requireProjectScope(c);

  const body = await c.req.json();
  const parsed = createTokenSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const tokenService = new TokenService(c.env.DB);

  const token = await tokenService.createToken({
    projectId,
    organizationId: orgId,
    createdBy: auth.id,
    name: parsed.data.name,
    symbol: parsed.data.symbol,
    decimals: parsed.data.decimals,
    description: parsed.data.description,
    uri: parsed.data.uri,
    imageUrl: parsed.data.imageUrl,
    extensions: parsed.data.extensions,
    maxSupply: parsed.data.maxSupply,
    isMintable: parsed.data.isMintable,
    isFreezable: parsed.data.isFreezable,
    requiresAllowlist: parsed.data.requiresAllowlist,
  });

  // Audit log
  const auditService = new AuditService(c.env.DB);
  await auditService.log(c, {
    action: "create",
    resourceType: "token",
    resourceId: token.id,
    metadata: { name: token.name, symbol: token.symbol },
  });

  const response: TokenResponse = { token };
  return created(c, response);
};

export const listTokens = async (c: AppContext) => {
  const { projectId } = requireProjectScope(c);

  const status = c.req.query("status") as "pending" | "active" | "paused" | "revoked" | undefined;
  const page = Number.parseInt(c.req.query("page") ?? "1", 10);
  const pageSize = Math.min(Number.parseInt(c.req.query("pageSize") ?? "50", 10), 100);
  const offset = (page - 1) * pageSize;

  const tokenService = new TokenService(c.env.DB);
  const { tokens, total } = await tokenService.listTokens(projectId, {
    status,
    limit: pageSize,
    offset,
  });

  return paginated(c, tokens, { total, page, pageSize });
};

export const getToken = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const auth = getAuth(c);

  const tokenService = new TokenService(c.env.DB);
  const token = await tokenService.getToken(tokenId);

  if (!token || token.organizationId !== auth?.organizationId) {
    throw notFound("Token");
  }

  // If using project-scoped key, verify token belongs to that project
  if (auth?.projectId && token.projectId !== auth.projectId) {
    throw notFound("Token");
  }

  const response: TokenResponse = { token };
  return success(c, response);
};

export const updateToken = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const auth = getAuth(c);

  const body = await c.req.json();
  const parsed = updateTokenSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const tokenService = new TokenService(c.env.DB);

  // Verify ownership
  const existing = await tokenService.getToken(tokenId);
  if (!existing || existing.organizationId !== auth?.organizationId) {
    throw notFound("Token");
  }

  if (auth?.projectId && existing.projectId !== auth.projectId) {
    throw notFound("Token");
  }

  try {
    const token = await tokenService.updateToken(tokenId, parsed.data);

    // Audit log
    const auditService = new AuditService(c.env.DB);
    await auditService.log(c, {
      action: "update",
      resourceType: "token",
      resourceId: tokenId,
      metadata: parsed.data,
    });

    const response: TokenResponse = { token };
    return success(c, response);
  } catch (error) {
    if (error instanceof Error && error.message === "TOKEN_NOT_FOUND") {
      throw notFound("Token");
    }
    throw error;
  }
};
