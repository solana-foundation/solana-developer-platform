import { denormalizeFireblocksWalletId } from "@sdp/custody/provider-wallet-ids";
import {
  fireblocksRuleScope,
  fireblocksUngatedRuleJudged,
  inspectFireblocksPolicy,
  type PolicyResult,
  readFireblocksPolicy,
} from "@sdp/custody/providers/fireblocks/policy";
import { resolveFireblocksTransferAsset } from "@sdp/custody/providers/fireblocks/transfers";
import { currentClusterScope } from "@sdp/rpc/scope";
import type { ProviderPolicyCheck } from "@sdp/types/custody";
import { wellKnownMint } from "@sdp/types/well-known-tokens";
import { getDb } from "@/db/client";
import { mapWithConcurrency } from "@/lib/concurrency";
import { getLogger } from "@/runtime/logger";
import { createSystemAuditService } from "@/services/audit.service";
import { createCredentialSecretStore } from "@/services/credential-secret-store";
import { proposalRuntime } from "@/services/custody/signing/admitted-proposer";
import {
  CustodyPolicyStore,
  type PolicyCheckScope,
  type PolicyCheckTarget,
} from "@/services/stores/custody-policy.store";
import type { Env } from "@/types/env";
import { parseByokCredential } from "./byok-credential";
import { readPrivyWalletPolicy } from "./privy-policy";

/** A batch claims up to 25 wallets; at most this many provider reads run at once. */
const PROVIDER_READ_CONCURRENCY = 5;

/** All policy failures are observations, never permission to sign or reasons to block setup. */
async function inspectBatch(
  env: Env,
  targets: PolicyCheckTarget[]
): Promise<Array<{ target: PolicyCheckTarget; result: PolicyResult }>> {
  const credentials = new Map<string, ReturnType<typeof loadCredential>>();
  const policies = new Map<string, ReturnType<typeof readFireblocksPolicy>>();
  async function loadCredential(target: PolicyCheckTarget) {
    const payload = await createCredentialSecretStore(env, target.storage_backend).read({
      orgId: target.organization_id,
      stored: {
        storageBackend: target.storage_backend,
        secretRef: target.secret_ref ?? undefined,
        secretVersionRef: target.secret_version_ref ?? undefined,
        encryptedSecretPayload: target.encrypted_secret_payload ?? undefined,
      },
    });
    return parseByokCredential(target.provider, payload);
  }
  const inspect = async (target: PolicyCheckTarget): Promise<PolicyResult> => {
    try {
      let credentialRead = credentials.get(target.provider_credential_id);
      if (!credentialRead) {
        credentialRead = loadCredential(target);
        credentials.set(target.provider_credential_id, credentialRead);
      }
      const credential = await credentialRead;
      if (credential.provider === "privy") {
        return await readPrivyWalletPolicy(env, credential, target.wallet_id);
      }
      let policyRead = policies.get(target.provider_credential_id);
      if (!policyRead) {
        policyRead = readFireblocksPolicy(proposalRuntime, {
          ...credential,
          apiBaseUrl: env.FIREBLOCKS_API_BASE_URL,
        });
        policies.set(target.provider_credential_id, policyRead);
      }
      const policy = await policyRead;
      if ("error" in policy) return policy.error;
      // The read returns the parsed policy envelope; every judgement below walks
      // it without parsing the payload again.
      const vaultId = denormalizeFireblocksWalletId(target.wallet_id);
      // Rules naming the native asset (or any asset) decide the result on their
      // own; the USDC asset id only matters when a rule names some other asset,
      // which may be the USDC rule the wallet's coverage question turns on.
      const native = inspectFireblocksPolicy(policy.value, vaultId, [credential.assetId]);
      const scope = fireblocksRuleScope(policy.value, vaultId, [credential.assetId]);
      if (scope === "native") return native;
      if (scope === "unknown") {
        // A rule the asset list cannot name may still let the credential move
        // funds alone, so absence is not proven; re-judging without an asset
        // list keeps every finding the readable rules prove.
        return inspectFireblocksPolicy(policy.value, vaultId, null);
      }
      // An ungated rule the native list already judged (the native asset or a
      // wildcard) proves the credential can move funds alone; no token catalogue
      // can revise that finding, so report it before the optional USDC
      // resolution can fail. A missing reading with no rule judged — an
      // unrelated asset's allow rule — waits for the combined check.
      if (fireblocksUngatedRuleJudged(policy.value, vaultId, [credential.assetId])) return native;
      const mint = wellKnownMint("USDC", currentClusterScope().cluster);
      if (!mint) throw new Error("No canonical USDC mint for this cluster");
      const usdc = await resolveFireblocksTransferAsset(
        proposalRuntime,
        { ...credential, apiBaseUrl: env.FIREBLOCKS_API_BASE_URL },
        credential.assetId,
        mint
      );
      // The native and USDC rules must be judged together: an allow rule without
      // approvers on either asset means the credential can move funds alone, and a
      // gated rule on one asset must not hide an ungated rule on the other.
      return inspectFireblocksPolicy(policy.value, vaultId, [credential.assetId, usdc.id]);
    } catch (error) {
      // The error's class tells a credential-store failure from a provider read
      // failure; provider bodies, credentials, secrets and policy contents are
      // never logged.
      getLogger().warn(
        {
          event: "sdp_api_custody_provider_policy_inspect_failed",
          organizationId: target.organization_id,
          projectId: target.project_id,
          custodyConnectionId: target.custody_connection_id,
          custodyWalletId: target.id,
          provider: target.provider,
          errorClass: error instanceof Error ? error.name : typeof error,
        },
        "Custody provider policy inspection failed"
      );
      return { status: "unknown", reason: "provider_unavailable" };
    }
  };
  // One Privy read per wallet, one Fireblocks policy read per credential. The bound keeps
  // a slow provider from holding the whole batch open for minutes. The inspect closure
  // observes every failure, so the bounded map cannot reject.
  const results = await mapWithConcurrency(targets, PROVIDER_READ_CONCURRENCY, inspect);
  return results.map((result, index) => ({
    // SAFETY: mapWithConcurrency returns one result per target in input order.
    target: targets[index] as PolicyCheckTarget,
    result,
  }));
}

async function checkPolicies(env: Env, scope: PolicyCheckScope) {
  const audit = createSystemAuditService(env);
  const targets = await new CustodyPolicyStore(getDb(env)).claim(scope, 25);
  const results = await inspectBatch(env, targets);
  for (const { target, result } of results) {
    const check: ProviderPolicyCheck = { ...result, checkedAt: new Date().toISOString() };
    // The ledger keeps observations that change the picture: a changed
    // observation and its audit entry commit in one audited write, which holds
    // the ledger's writer lock. An unchanged hourly repeat records outside that
    // write — it refreshes the wallet silently while the log line stays hourly.
    const changed =
      target.previous_status !== check.status ||
      target.previous_reason !== check.reason ||
      target.previous_credential_id !== target.provider_credential_id;
    const recorded = changed
      ? await audit.logSystemWithin(async (tx) => {
          const saved = await new CustodyPolicyStore(tx).record(target, check);
          return {
            result: saved,
            entry: saved
              ? {
                  organizationId: target.organization_id,
                  action: "check",
                  resourceType: "custody_connection",
                  resourceId: target.custody_connection_id,
                  metadata: {
                    event: "custody_provider_policy_checked",
                    projectId: target.project_id,
                    walletId: target.id,
                    provider: target.provider,
                    environment: scope.environment,
                    ...check,
                  },
                  status: "success",
                }
              : null,
          };
        })
      : await new CustodyPolicyStore(getDb(env)).record(target, check);
    if (recorded)
      getLogger().info(
        {
          event: "sdp_api_custody_provider_policy_checked",
          organizationId: target.organization_id,
          projectId: target.project_id,
          custodyConnectionId: target.custody_connection_id,
          custodyWalletId: target.id,
          provider: target.provider,
          environment: scope.environment,
          policyStatus: check.status,
          policyMissing: check.status === "missing" ? 1 : 0,
          reason: check.reason,
        },
        "Custody provider policy observation"
      );
  }
}

export async function checkDueProviderPolicies(env: Env): Promise<void> {
  await checkPolicies(env, { environment: currentClusterScope().environment });
}
