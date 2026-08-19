import { assertValidAddress } from "@sdp/solana/address";
import type { Context } from "hono";
import { z } from "zod";
import {
  createCounterpartiesRepository,
  createKycWalletsRepository,
  createWalletAssetEnrollmentsRepository,
} from "@/db/repositories";
import { badRequest, notFound } from "@/lib/errors";
import { parsePagination } from "@/lib/query";
import { created, success } from "@/lib/response";
import { getRequestTenantScope } from "@/lib/tenant-scope";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { emitKycApprovedForClearedEnrollments } from "@/services/workflows/clearance";
import type { Env } from "@/types/env";
import { getTenantTokenService, requireProjectScope } from "../helpers";

type AppContext = Context<{ Bindings: Env }>;

export const enrollHolderSchema = z.object({
  walletAddress: z.string(),
  counterpartyId: z.string().nullish(),
  reviewMode: z.enum(["auto", "manual"]).optional(),
});

// Enroll a holder for an asset — the v1 "clearance" act: upsert the SDP-owned
// kyc_wallets identity row (+ counterparty link) and an active enrollment. If the
// wallet is already verified, this completes clearance and emits kyc_approved.
export const enrollHolder = async (c: ValidatedBodyContext<typeof enrollHolderSchema>) => {
  const { tokenId } = c.req.param();
  const { auth, projectId, orgId } = requireProjectScope(c);

  const body = c.req.valid("json");
  assertValidAddress(body.walletAddress, "walletAddress");

  const token = await getTenantTokenService(c).getToken({
    tokenId,
    organizationId: orgId,
    projectId,
  });
  if (!token) {
    throw notFound("Token");
  }

  // The counterparty link is only constrained by a foreign key, which accepts any id in
  // the table — including another org's. Resolving it in scope first turns a cross-tenant
  // reference into a 404 instead of a successful link, and an unknown id into a 404
  // instead of an FK violation surfacing as a 500.
  const counterpartyId = body.counterpartyId ?? null;
  if (counterpartyId) {
    const counterparty = await createCounterpartiesRepository(
      c.env,
      getRequestTenantScope(c)
    ).getCounterpartyById({
      counterpartyId,
      organizationId: orgId,
      projectId,
    });
    if (!counterparty) {
      throw notFound("Counterparty");
    }
  }

  const wallet = await createKycWalletsRepository(c.env).upsertKycWallet({
    organizationId: orgId,
    projectId,
    walletAddress: body.walletAddress,
    counterpartyId,
    createdBy: auth.id,
  });
  if (!wallet) {
    throw badRequest("Failed to register KYC wallet");
  }

  const enrollment = await createWalletAssetEnrollmentsRepository(c.env).upsertEnrollment({
    organizationId: orgId,
    projectId,
    kycWalletId: wallet.id,
    tokenId,
    reviewMode: body.reviewMode,
    createdBy: auth.id,
  });

  // Covers the "KYC approved before the operator enrolled them" ordering.
  const dispatched = await emitKycApprovedForClearedEnrollments(c.env, { kycWallet: wallet });

  return created(c, { wallet, enrollment, dispatched });
};

// The asset's enrolled (verified/pending) wallets — the reverse lookup.
export const listHolders = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const { projectId, orgId } = requireProjectScope(c);

  const { page, pageSize, offset } = parsePagination(
    { page: c.req.query("page"), pageSize: c.req.query("pageSize") },
    { pageSize: 50, maxPageSize: 200 }
  );

  const { rows, total } = await createWalletAssetEnrollmentsRepository(
    c.env
  ).listEnrolledWalletsForToken({
    tokenId,
    organizationId: orgId,
    projectId,
    limit: pageSize,
    offset,
  });

  return success(c, { holders: rows, total, page, pageSize });
};
