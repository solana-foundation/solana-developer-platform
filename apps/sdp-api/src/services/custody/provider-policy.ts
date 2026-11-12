import { denormalizeFireblocksWalletId } from "@sdp/custody/provider-wallet-ids";
import {
  inspectFireblocksPolicy,
  type PolicyResult,
  readFireblocksPolicy,
} from "@sdp/custody/provisioning/fireblocks-policy";
import { resolveFireblocksTransferAsset } from "@sdp/custody/provisioning/fireblocks-transfers";
import type { CustodyProvisioningRuntime } from "@sdp/custody/provisioning/runtime";
import { currentClusterScope } from "@sdp/rpc/scope";
import type { ProviderPolicyCheck } from "@sdp/types/custody";
import { wellKnownMint } from "@sdp/types/well-known-tokens";
import { type DatabaseClient, getDb } from "@/db/client";
import { getAuth, requireProjectId } from "@/lib/auth";
import type { AppContext } from "@/routes/custody/context";
import { getLogger } from "@/runtime/logger";
import {
  type AuditLogEntry,
  AuditService,
  createSystemAuditService,
} from "@/services/audit.service";
import { createCredentialSecretStore } from "@/services/credential-secret-store";
import {
  CustodyPolicyStore,
  type PolicyCheckScope,
  type PolicyCheckTarget,
} from "@/services/stores/custody-policy.store";
import type { Env } from "@/types/env";
import { parseByokCredential } from "./byok-credential";
import { readPrivyWalletPolicy } from "./privy-policy";

const runtime: CustodyProvisioningRuntime = {
  fetch: (input, init) => globalThis.fetch(input, init),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  randomUUID: () => crypto.randomUUID(),
  getRandomValues: (data) => crypto.getRandomValues(new Uint8Array(data)),
  sha256: (data) => crypto.subtle.digest("SHA-256", new Uint8Array(data)),
};
type AuditedWrite = (
  work: (tx: DatabaseClient) => Promise<{ entry: AuditLogEntry | null; result: boolean }>
) => Promise<boolean>;

/** All policy failures are observations, never permission to sign or reasons to block setup. */
async function inspectBatch(
  env: Env,
  targets: PolicyCheckTarget[]
): Promise<Array<{ target: PolicyCheckTarget; result: PolicyResult }>> {
  const credentials = new Map<string, ReturnType<typeof loadCredential>>();
  const policies = new Map<string, ReturnType<typeof readFireblocksPolicy>>();
  async function loadCredential(target: PolicyCheckTarget) {
    if (target.source !== "stored")
      throw new Error("Policy inspection requires stored credentials");
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
  const results: Array<{ target: PolicyCheckTarget; result: PolicyResult }> = [];
  for (const target of targets) {
    const record = (result: PolicyResult) => results.push({ target, result });
    try {
      let credentialRead = credentials.get(target.provider_credential_id);
      if (!credentialRead) {
        credentialRead = loadCredential(target);
        credentials.set(target.provider_credential_id, credentialRead);
      }
      const credential = await credentialRead;
      if (credential.provider === "privy") {
        record(await readPrivyWalletPolicy(env, credential, target.wallet_id));
        continue;
      }
      let policyRead = policies.get(target.provider_credential_id);
      if (!policyRead) {
        policyRead = readFireblocksPolicy(runtime, {
          ...credential,
          apiBaseUrl: env.FIREBLOCKS_API_BASE_URL,
        });
        policies.set(target.provider_credential_id, policyRead);
      }
      const policy = await policyRead;
      // Presence of a native Transfer rule. RAW signing is not proven by this check.
      if ("error" in policy) {
        record(policy.error);
        continue;
      }
      const vaultId = denormalizeFireblocksWalletId(target.wallet_id);
      const native = inspectFireblocksPolicy(policy.value, vaultId, [credential.assetId]);
      if (native.status !== "missing") {
        record(native);
        continue;
      }
      // No rule for this vault at all: the token catalogue cannot change that answer.
      if (inspectFireblocksPolicy(policy.value, vaultId, null).status === "missing") {
        record(native);
        continue;
      }
      const mint = wellKnownMint("USDC", currentClusterScope().cluster);
      if (!mint) throw new Error("No canonical USDC mint for this cluster");
      const usdc = await resolveFireblocksTransferAsset(
        runtime,
        { ...credential, apiBaseUrl: env.FIREBLOCKS_API_BASE_URL },
        credential.assetId,
        mint
      );
      record(inspectFireblocksPolicy(policy.value, vaultId, [credential.assetId, usdc.id]));
    } catch {
      // Do not log provider bodies, credentials, secrets, or policy contents.
      record({ status: "unknown", reason: "provider_unavailable" });
    }
  }
  return results;
}

async function checkPolicies(env: Env, scope: PolicyCheckScope, audit: AuditedWrite) {
  const targets = await new CustodyPolicyStore(getDb(env)).claim(scope, 25);
  const results = await inspectBatch(env, targets);
  for (const { target, result } of results) {
    const check: ProviderPolicyCheck = { ...result, checkedAt: new Date().toISOString() };
    const recorded = await audit(async (tx) => {
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
    });
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
  const audit = createSystemAuditService(env);
  await checkPolicies(env, { environment: currentClusterScope().environment }, (work) =>
    audit.logSystemWithin(work)
  );
}

/** Setup has already committed. The periodic queue recovers any interrupted observation. */
export function checkConnectedProviderPolicies(c: AppContext, connectionId: string): void {
  // Advisory work must not delay the response it follows, so the observation
  // continues in the background. Without a request ExecutionContext (a bare
  // app.request call in tests) nothing keeps the work alive past the response,
  // so it does not start — the periodic queue claims these targets either way.
  let waitUntil: (promise: Promise<unknown>) => void;
  try {
    const executionCtx = c.executionCtx;
    waitUntil = (promise) => executionCtx.waitUntil(promise);
  } catch {
    return;
  }
  waitUntil(observeConnectionPolicies(c, connectionId));
}

/** Created under the request's database identity, so its audited writes keep it. */
async function observeConnectionPolicies(c: AppContext, connectionId: string): Promise<void> {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  try {
    const audit = new AuditService(getDb(c.env));
    await checkPolicies(
      c.env,
      {
        environment: currentClusterScope().environment,
        connection: { organizationId: auth.organizationId, projectId, id: connectionId },
      },
      (work) => audit.logWithin(c, work)
    );
  } catch {
    getLogger().warn(
      { event: "sdp_api_custody_provider_policy_check_failed", custodyConnectionId: connectionId },
      "Policy check will be retried by the worker"
    );
  }
}
