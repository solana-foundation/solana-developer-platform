import type { TransactionSigner } from "@solana/kit";
import type { Context } from "hono";
import { type DatabaseClient, getDb } from "@/db";
import { getAuth, requireProjectId } from "@/lib/auth";
import { getRequestTenantScope } from "@/lib/tenant-scope";
import { createMosaicService, type MosaicFeePayment } from "@/services/issuance/mosaic";
import { createToken2022Service } from "@/services/solana";
import { resolveRequestSponsorshipScope } from "@/services/sponsorship.service";
import { TokenService } from "@/services/token.service";
import type { Env } from "@/types/env";

export type AppContext = Context<{ Bindings: Env }>;

/**
 * Resolve project scope for issuance routes. The projectContextMiddleware
 * already validates project membership (or pins API key actors to their
 * own projectId) before this helper is reached, so we just unwrap the
 * resolved values here.
 */
export const requireProjectScope = (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  return { auth, projectId, orgId: auth.organizationId };
};

/**
 * The only tenant-facing TokenService construction path. Its scope comes from
 * authenticated middleware state, never request-controlled headers or bodies.
 */
export const getTenantTokenService = (
  c: AppContext,
  db: DatabaseClient = getDb(c.env)
): TokenService => new TokenService(db, getRequestTenantScope(c));

export const createIssuanceMosaicService = (
  c: AppContext,
  signer: TransactionSigner,
  feePayment: MosaicFeePayment
) =>
  createMosaicService(
    c.env,
    signer,
    feePayment,
    feePayment === "sponsored" ? resolveRequestSponsorshipScope(c) : undefined
  );

export const createIssuanceToken2022Service = (c: AppContext, signer: TransactionSigner) =>
  createToken2022Service(c.env, signer, resolveRequestSponsorshipScope(c));
