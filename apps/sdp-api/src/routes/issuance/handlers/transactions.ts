import type { TokenTransaction } from "@sdp/types";
import type { Context } from "hono";
import { getDb } from "@/db";
import { getAuth } from "@/lib/auth";
import { notFound } from "@/lib/errors";
import { paginated } from "@/lib/response";
import { TokenService } from "@/services/token.service";
import type { Env } from "@/types/env";

type AppContext = Context<{ Bindings: Env }>;

export const listTokenTransactions = async (c: AppContext) => {
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

  const status = c.req.query("status") as
    | "pending"
    | "processing"
    | "confirmed"
    | "finalized"
    | "failed"
    | undefined;
  const page = Number.parseInt(c.req.query("page") ?? "1", 10);
  const pageSize = Math.min(Number.parseInt(c.req.query("pageSize") ?? "50", 10), 100);
  const offset = (page - 1) * pageSize;

  const { transactions, total } = await tokenService.listTokenTransactions(tokenId, {
    status,
    organizationId: auth.organizationId,
    limit: pageSize,
    offset,
  });

  return paginated<TokenTransaction>(c, transactions, { total, page, pageSize });
};
