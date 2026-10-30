import type { Context } from "hono";
import { getDb } from "@/db/client";
import { getAuth } from "@/lib/auth";
import { AppError, conflict, serviceUnavailable } from "@/lib/errors";
import { isProductionEntitled } from "@/lib/production-entitlement";
import { success } from "@/lib/response";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { AuditService } from "@/services/audit.service";
import {
  notifyMainnetAccessRequest,
  readMainnetAccessRow,
  recordMainnetAccessRequest,
  toMainnetAccess,
} from "@/services/mainnet-access.service";
import { mainnetAccessEmailConfig } from "@/services/mainnet-access-email";
import type { Env } from "@/types/env";
import type { requestMainnetAccessSchema } from "./schemas";

type AppContext = Context<{ Bindings: Env }>;

function requireOwnOrganization(c: AppContext): string {
  const { orgId } = c.req.param();
  if (getAuth(c).organizationId !== orgId) {
    throw new AppError("FORBIDDEN", "Access denied to this organization");
  }
  return orgId;
}

export const getMainnetAccess = async (c: AppContext) => {
  const orgId = requireOwnOrganization(c);
  const row = await readMainnetAccessRow(getDb(c.env), orgId);
  return success(c, toMainnetAccess(c.env, row, isProductionEntitled(c)));
};

/**
 * Records the organization's jurisdiction, its Terms and Conditions acceptance and the request,
 * with their audit record, in one transaction; then emails the SDP alias. A failed email leaves
 * the request recorded and unsent, and the next submit sends it.
 */
export const requestMainnetAccess = async (
  c: ValidatedBodyContext<typeof requestMainnetAccessSchema>
) => {
  const orgId = requireOwnOrganization(c);
  const auth = getAuth(c);
  if (auth.authType !== "clerk") {
    throw new AppError("FORBIDDEN", "Only a signed-in admin may request mainnet access");
  }
  if (isProductionEntitled(c)) {
    throw conflict("Mainnet is already enabled for this organization");
  }
  // Refused before anything is recorded: a request no one is told about is not a request.
  if (!mainnetAccessEmailConfig(c.env)) {
    throw serviceUnavailable("Mainnet access requests are not available on this deployment");
  }
  const body = c.req.valid("json");

  const row = await new AuditService(getDb(c.env)).logWithin(c, async (tx) => {
    const { row: recorded, created } = await recordMainnetAccessRequest(tx, {
      organizationId: orgId,
      userId: auth.userId,
      countryCode: body.countryCode,
      termsVersion: body.termsVersion,
    });
    // A resend of an unsent request changes nothing, so it has nothing new to audit.
    return {
      result: recorded,
      entry: created
        ? {
            action: "create",
            resourceType: "organization",
            resourceId: orgId,
            metadata: {
              event: "mainnet_access_requested",
              countryCode: recorded.country_code,
              termsVersion: recorded.terms_version,
              termsAcceptedAt: recorded.terms_accepted_at,
            },
          }
        : null,
    };
  });

  const notified = await notifyMainnetAccessRequest(c.env, getDb(c.env), row);
  return success(c, toMainnetAccess(c.env, notified, false), 201);
};
