import type { Context } from "hono";
import { getDb } from "@/db/client";
import { conflict, forbidden, serviceUnavailable } from "@/lib/errors";
import { isProductionEntitled } from "@/lib/production-entitlement";
import { success } from "@/lib/response";
import { requireHumanActor } from "@/middleware/human-session";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { AuditService } from "@/services/audit.service";
import {
  notifyMainnetAccessRequest,
  readMainnetAccessRow,
  recordMainnetAccessRequest,
  toMainnetAccess,
  unsentMainnetAccessRequest,
} from "@/services/mainnet-access.service";
import { mainnetAccessEmailConfig } from "@/services/mainnet-access-email";
import type { Env } from "@/types/env";
import type { requestMainnetAccessSchema } from "./schemas";

type AppContext = Context<{ Bindings: Env }>;

/** The signed-in admin, acting on their own organization only. */
function requireOwnOrganization(c: AppContext): { orgId: string; userId: string } {
  const { orgId } = c.req.param();
  const actor = requireHumanActor(c);
  if (actor.organizationId !== orgId) throw forbidden("Access denied to this organization");
  return { orgId, userId: actor.userId };
}

/**
 * Refused before anything is recorded or sent: a request no one is told about is not a request.
 * The GET reports the same decision as `available`.
 */
function requireRequestsAvailable(c: AppContext): void {
  if (isProductionEntitled(c)) {
    throw conflict("Mainnet is already enabled for this organization");
  }
  if (!mainnetAccessEmailConfig(c.env)) {
    throw serviceUnavailable("Mainnet access requests are not available on this deployment");
  }
}

export const getMainnetAccess = async (c: AppContext) => {
  const { orgId } = requireOwnOrganization(c);
  const row = await readMainnetAccessRow(getDb(c.env), orgId);
  return success(c, toMainnetAccess(c.env, row, isProductionEntitled(c)));
};

/**
 * Records the organization's jurisdiction, its Terms and Conditions acceptance and the request,
 * with their audit record, in one transaction; then emails the SDP alias. A failed email leaves
 * the request recorded and unsent, for `POST …/notify` to send.
 */
export const requestMainnetAccess = async (
  c: ValidatedBodyContext<typeof requestMainnetAccessSchema>
) => {
  const { orgId, userId } = requireOwnOrganization(c);
  requireRequestsAvailable(c);
  const body = c.req.valid("json");

  const row = await new AuditService(getDb(c.env)).logWithin(c, async (tx) => {
    const recorded = await recordMainnetAccessRequest(tx, {
      organizationId: orgId,
      userId,
      countryCode: body.countryCode,
      termsVersion: body.termsVersion,
    });
    return {
      result: recorded,
      entry: {
        action: "create",
        resourceType: "organization",
        resourceId: orgId,
        metadata: {
          event: "mainnet_access_requested",
          countryCode: recorded.country_code,
          termsVersion: recorded.terms_version,
          requestedAt: recorded.requested_at,
        },
      },
    };
  });

  const notified = await notifyMainnetAccessRequest(c.env, getDb(c.env), row);
  return success(c, toMainnetAccess(c.env, notified, false), 201);
};

/** Sends the recorded request whose email did not go out. Changes nothing else, so it audits nothing. */
export const notifyMainnetAccess = async (c: AppContext) => {
  const { orgId } = requireOwnOrganization(c);
  requireRequestsAvailable(c);
  const db = getDb(c.env);
  const row = await unsentMainnetAccessRequest(db, orgId);
  const notified = await notifyMainnetAccessRequest(c.env, db, row);
  return success(c, toMainnetAccess(c.env, notified, false));
};
