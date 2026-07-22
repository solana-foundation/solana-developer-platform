import type { AssetAuditEvent } from "@sdp/types";
import type { Context } from "hono";
import { getDb } from "@/db";
import { badRequest, notFound } from "@/lib/errors";
import { paginated } from "@/lib/response";
import { type AuditAction, AuditService, isAuditAction } from "@/services/audit.service";
import { TokenService } from "@/services/token.service";
import type { Env } from "@/types/env";
import { requireProjectScope } from "../helpers";

type AppContext = Context<{ Bindings: Env }>;

function parsePositiveInteger(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.min(parsed, max);
}

/**
 * GET /v1/issuance/tokens/:tokenId/audit
 *
 * Per-asset audit history: the aggregated activity feed for one issued token,
 * assembled from the existing `audit_logs` write pipeline. Supports filtering by
 * action type and pagination.
 */
export const getAssetAuditHistory = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const { orgId, projectId } = requireProjectScope(c);

  const db = getDb(c.env);
  const tokenService = new TokenService(db);
  const token = await tokenService.getToken({ tokenId, organizationId: orgId, projectId });
  if (!token) {
    throw notFound("Token");
  }

  const actionRaw = c.req.query("action")?.trim();
  let action: AuditAction | undefined;
  if (actionRaw) {
    if (!isAuditAction(actionRaw)) {
      throw badRequest("Invalid action query parameter", { action: actionRaw });
    }
    action = actionRaw;
  }

  const page = parsePositiveInteger(c.req.query("page"), 1, Number.MAX_SAFE_INTEGER);
  const pageSize = parsePositiveInteger(c.req.query("pageSize"), 50, 100);
  const offset = (page - 1) * pageSize;

  const auditService = new AuditService(db);
  const [events, total] = await Promise.all([
    auditService.getForAsset(orgId, tokenId, { action, limit: pageSize, offset }),
    auditService.countForAsset(orgId, tokenId, { action }),
  ]);

  const data: AssetAuditEvent[] = events.map((event) => ({
    id: event.id,
    action: event.action,
    resourceType: event.resourceType,
    resourceId: event.resourceId,
    actorType: event.actorType,
    actorLabel: event.actorLabel,
    status: event.status,
    createdAt: event.createdAt,
    metadata: event.metadata,
  }));

  return paginated<AssetAuditEvent>(c, data, { total, page, pageSize });
};
