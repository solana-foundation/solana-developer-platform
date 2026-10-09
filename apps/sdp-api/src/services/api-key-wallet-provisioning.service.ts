import type { CustodyWalletOwnerTarget, CustodyWalletPurpose } from "@sdp/types";
import type { Context } from "hono";
import type { DatabaseClient } from "@/db";
import { CustodyRuntimeTargets } from "@/services/domain/signing/custody-runtime-target";
import { createSigningService } from "@/services/domain/signing.service";
import type { Env } from "@/types/env";

/**
 * Provision a new custody wallet under the provider account the caller names:
 * a BYOK connection, or the project's Managed config for a provider.
 *
 * @param db - Database client for the connection path.
 * @param env - API process environment.
 * @param params - The wallet to provision.
 * @param params.auditContext - Authenticated initiating request for wallet creation audit.
 * @param params.creationReason - Why the wallet is created, recorded on the audit intent.
 * @param params.organizationId - The organization that owns the project.
 * @param params.projectId - The project the wallet belongs to.
 * @param params.owner - The connection or Managed provider the wallet lives under.
 * @param params.label - Optional wallet label.
 * @param params.purpose - Optional wallet purpose.
 * @returns The new wallet's record ID and provider wallet ID.
 */
export async function provisionApiKeyWallet(
  db: DatabaseClient,
  env: Env,
  params: {
    auditContext: Context<{ Bindings: Env }>;
    creationReason: "api_key" | "dvp_settlement_authority";
    organizationId: string;
    projectId: string;
    owner: CustodyWalletOwnerTarget;
    label?: string;
    purpose?: CustodyWalletPurpose;
  }
): Promise<{ id: string; walletId: string }> {
  if (params.owner.connectionId !== undefined) {
    return new CustodyRuntimeTargets(db, env, new Map()).createConnectionWallet({
      auditContext: params.auditContext,
      creationReason: params.creationReason,
      organizationId: params.organizationId,
      projectId: params.projectId,
      connectionId: params.owner.connectionId,
      label: params.label,
      purpose: params.purpose,
    });
  }

  return createSigningService(env).createWallet(params.organizationId, params.projectId, {
    provider: params.owner.provider,
    label: params.label,
    purpose: params.purpose,
  });
}
