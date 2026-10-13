import { SigningError } from "@sdp/custody/signing";
import { currentClusterScope } from "@sdp/rpc/scope";
import type { SdpEnvironment } from "@sdp/types";
import type { TransactionSigner } from "@solana/kit";
import { getDb } from "@/db";
import { logEvent } from "@/runtime/money-path-events";
import { createSigningService } from "@/services/domain/signing.service";
import type { Env } from "@/types/env";

type ScopedCustodyWallet = Readonly<{
  orgId: string;
  projectId: string;
  custodyWalletId: string;
}>;

type WalletScopeRefusal = Readonly<{
  reason: "project_mismatch" | "environment_mismatch" | "project_not_found";
  scopeProjectId: string | null;
  scopeEnvironment: SdpEnvironment;
  walletEnvironment: SdpEnvironment | null;
}>;

/**
 * Resolve the signer for one already-authorized custody-wallet database row. The one
 * function every custody signing path passes through, so it refuses a wallet outside
 * the open cluster scope before any provider call: under a request scope the wallet's
 * project must be the request's project; under a job or webhook scope (no project) the
 * wallet's project environment must be the scope's environment. The wallet row is then
 * resolved only within `projectId`, so its `project_id` is the one checked here.
 *
 * @param env - API process environment.
 * @param orgId - The organization that owns the wallet's project.
 * @param projectId - The project the wallet belongs to.
 * @param custodyWalletId - The custody-wallet database row ID.
 * @returns The wallet's transaction signer, on the scope's cluster.
 * @throws SigningError `WALLET_NOT_FOUND` when the wallet's project is outside the open scope.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` when no cluster scope is open.
 */
export async function createOrgSignerForCustodyWallet(
  env: Env,
  orgId: string,
  projectId: string,
  custodyWalletId: string
): Promise<TransactionSigner> {
  await assertWalletProjectInClusterScope(env, { orgId, projectId, custodyWalletId });
  const signingService = createSigningService(env);
  return signingService.getTransactionSignerForWalletRecord(orgId, projectId, custodyWalletId);
}

/**
 * Refuses a wallet whose project is outside the open cluster scope.
 *
 * @param env - API process environment.
 * @param wallet - The wallet about to sign.
 * @param wallet.orgId - The organization that owns the wallet's project.
 * @param wallet.projectId - The wallet's project.
 * @param wallet.custodyWalletId - The custody-wallet database row ID.
 * @throws SigningError `WALLET_NOT_FOUND` when a request scope names another project, or a
 *   job scope's environment differs from the project's or the project is not the organization's.
 */
async function assertWalletProjectInClusterScope(
  env: Env,
  wallet: ScopedCustodyWallet
): Promise<void> {
  const scope = currentClusterScope();
  if (scope.projectId !== null) {
    if (wallet.projectId !== scope.projectId) {
      refuseWalletOutsideScope(wallet, {
        reason: "project_mismatch",
        scopeProjectId: scope.projectId,
        scopeEnvironment: scope.environment,
        walletEnvironment: null,
      });
    }
    return;
  }

  const project = await getDb(env)
    .prepare("SELECT environment FROM projects WHERE id = ? AND organization_id = ? LIMIT 1")
    .bind(wallet.projectId, wallet.orgId)
    .first<{ environment: SdpEnvironment }>();
  if (!project) {
    refuseWalletOutsideScope(wallet, {
      reason: "project_not_found",
      scopeProjectId: null,
      scopeEnvironment: scope.environment,
      walletEnvironment: null,
    });
  }
  if (project.environment !== scope.environment) {
    refuseWalletOutsideScope(wallet, {
      reason: "environment_mismatch",
      scopeProjectId: null,
      scopeEnvironment: scope.environment,
      walletEnvironment: project.environment,
    });
  }
}

/**
 * Logs and throws the refusal for a wallet outside the open cluster scope. The refusal
 * reads as a missing wallet, so a caller learns nothing about another project's wallets.
 *
 * @param wallet - The refused wallet.
 * @param wallet.orgId - The organization that owns the wallet's project.
 * @param wallet.projectId - The wallet's project.
 * @param wallet.custodyWalletId - The custody-wallet database row ID.
 * @param refusal - Why the wallet is outside the scope.
 * @param refusal.reason - The refusal reason.
 * @param refusal.scopeProjectId - The scope's project, `null` in a job scope.
 * @param refusal.scopeEnvironment - The scope's environment.
 * @param refusal.walletEnvironment - The wallet project's environment, when it was read.
 * @throws SigningError `WALLET_NOT_FOUND`, always.
 */
function refuseWalletOutsideScope(wallet: ScopedCustodyWallet, refusal: WalletScopeRefusal): never {
  logEvent("warn", {
    event: "sdp_api_custody_signer_scope_refused",
    organization_id: wallet.orgId,
    project_id: wallet.projectId,
    custody_wallet_id: wallet.custodyWalletId,
    reason: refusal.reason,
    scope_project_id: refusal.scopeProjectId,
    scope_environment: refusal.scopeEnvironment,
    wallet_environment: refusal.walletEnvironment,
  });
  throw new SigningError("Custody wallet not found", "WALLET_NOT_FOUND");
}
