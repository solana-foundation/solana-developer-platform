import { generateKeyPairSync } from "node:crypto";
import { CUSTODY_CONNECTION_CHECK_STATUSES } from "@sdp/types/custody";
import { MOVEMENTS } from "@sdp/types/movements";
import { afterEach, aroundEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import {
  runWithoutDatabaseIdentity,
  runWithSystemDatabaseIdentity,
  runWithTenantDatabaseIdentity,
} from "@/db/identity";
import { runAsMoneyPrincipal } from "@/lib/money-principal";
import * as credentialSecretStore from "@/services/credential-secret-store";
import { createOrgTransferProposalRecovery } from "@/services/solana/signer";
import { seedProjectApiKey } from "@/test/helpers/api-keys";
import { inSandboxScope } from "@/test/helpers/cluster-rpc";
import { insertTestCustodyWalletRow } from "@/test/helpers/custody";
import {
  activateTestCustodyConnection,
  insertTestCustodyConnection,
  insertTestStoredProviderCredential,
} from "@/test/helpers/custody-connections";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import type { Env } from "@/types/env";
import { ProposalAdmissionRefusedError } from "./admitted-proposer";
import { CustodyRuntimeTargets } from "./custody-runtime-target";

const organizationId = "org_proposal_recovery";
const projectId = "prj_proposal_recovery";
const userId = "usr_proposal_recovery";
const apiKeyId = "key_proposal_recovery";
const custodyWalletId = "cwlt_proposal_recovery";
const connectionId = "cconn_proposal_recovery";
const credentialId = "pcred_proposal_recovery";
const sourceAddress = "11111111111111111111111111111111";
const binding = {
  connectionId,
  accountFingerprint: "sha256:original-account",
  vaultAccountId: "42",
  assetId: "SOL_TEST",
  sourceAddress,
};
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const testEnv: Env = {
  ...env,
  SDP_RELEASE_CHANNEL: "beta",
  CUSTODY_ENCRYPTION_KEY: Buffer.alloc(32, 11).toString("base64"),
  FIREBLOCKS_API_BASE_URL: "https://fireblocks.recovery.test",
};

aroundEach((runTest) =>
  runWithSystemDatabaseIdentity("cron:reconcile-custody-proposals", () => inSandboxScope(runTest))
);
afterEach(() => vi.restoreAllMocks());

beforeEach(async () => {
  testEnv.SDP_RELEASE_CHANNEL = "beta";
  await seedTestDatabase(env);
  const db = getDb(env);
  await db.execute(
    `INSERT INTO organizations (id, name, slug, tier, status, settings)
     VALUES (?, 'Proposal recovery', 'proposal-recovery', 'enterprise', 'active', ?)`,
    [organizationId, JSON.stringify({ providerOverrides: { custody: { fireblocks: true } } })]
  );
  await db.execute(
    `INSERT INTO users (id, email, email_verified, status)
     VALUES (?, 'proposal-recovery@example.com', 1, 'active')`,
    [userId]
  );
  await db.execute(
    `INSERT INTO organization_members (id, organization_id, user_id, role, status)
     VALUES ('mem_proposal_recovery', ?, ?, 'admin', 'active')`,
    [organizationId, userId]
  );
  await seedDefaultProjects(db, {
    organizationId,
    createdBy: userId,
    members: [userId],
    ids: { sandbox: projectId, production: `${projectId}_production` },
  });
  await seedProjectApiKey(db, testEnv, {
    key: { id: apiKeyId, raw: "test-proposal-recovery-key", prefix: "test" },
    organizationId,
    projectId,
    createdBy: userId,
    grants: MOVEMENTS["payments.transfer"].actions,
  });
  const stored = await credentialSecretStore
    .createCredentialSecretStore(testEnv, "encrypted_db")
    .write({
      orgId: organizationId,
      provider: "fireblocks",
      providerCredentialId: credentialId,
      payload: {
        apiKey: "retained-tenant-key",
        apiSecretPem: privateKey,
        vaultAccountId: binding.vaultAccountId,
        assetId: binding.assetId,
      },
    });
  await db.transaction(async (tx) => {
    await insertTestStoredProviderCredential(tx, {
      id: credentialId,
      organizationId,
      projectId,
      provider: "fireblocks",
      label: "Fireblocks",
      stored,
      displayMetadata: {},
      status: "active",
      credentialVersion: 1,
      rotatedFromProviderCredentialId: null,
      lastValidatedAt: null,
      deactivatedAt: null,
      createdBy: userId,
    });
    await insertTestCustodyConnection(tx, {
      id: connectionId,
      organizationId,
      projectId,
      provider: "fireblocks",
      credential: { id: credentialId, projectId },
      status: "pending",
      setupMetadata: {},
      providerAccountFingerprint: binding.accountFingerprint,
      lastCheckStatus: null,
      lastCheckAt: null,
      lastCheckFailureCode: null,
      activatedAt: null,
      deactivatedAt: null,
      createdBy: userId,
      createdAt: new Date().toISOString(),
    });
    await insertTestCustodyWalletRow(tx, {
      id: custodyWalletId,
      owner: { kind: "connection", custodyConnectionId: connectionId },
      walletId: `fb_${binding.vaultAccountId}`,
      publicKey: sourceAddress,
      label: null,
      purpose: "transfer",
      status: "active",
    });
    await activateTestCustodyConnection(tx, {
      connectionId,
      custodyWalletId,
      providerAccountFingerprint: binding.accountFingerprint,
    });
  });
});

function recovery() {
  return createOrgTransferProposalRecovery<"payments">(
    testEnv,
    organizationId,
    projectId,
    custodyWalletId,
    binding,
    "payments.transfer"
  );
}

function asKey<T>(work: () => T): T {
  return runAsMoneyPrincipal({ kind: "api_key", apiKeyId }, work);
}

describe("retained proposal recovery waist", () => {
  it("rejects a tenant caller before resolving recovery capabilities", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const secretRead = vi.spyOn(credentialSecretStore, "createCredentialSecretStore");
    await expect(
      runWithTenantDatabaseIdentity({ organizationId }, () => recovery())
    ).rejects.toThrow("Custody proposal recovery requires the recovery worker");
    expect(fetch).not.toHaveBeenCalled();
    expect(secretRead).not.toHaveBeenCalled();
  });

  it.each(["cron:track-pending-transfers", "cron:another-worker"])(
    "rejects %s before resolving recovery capabilities",
    async (component) => {
      await expect(runWithSystemDatabaseIdentity(component, () => recovery())).rejects.toThrow(
        "Custody proposal recovery requires the recovery worker"
      );
    }
  );

  it("rejects a caller with no database identity", async () => {
    await expect(
      runWithoutDatabaseIdentity("test:no-recovery-identity", () => recovery())
    ).rejects.toThrow("Custody proposal recovery requires the recovery worker");
  });
  it("constructs without admission, credential reads or provider calls", async () => {
    const dbRead = vi.spyOn(getDb(env), "queryMany");
    const secretRead = vi.spyOn(credentialSecretStore, "createCredentialSecretStore");
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(recovery()).resolves.toHaveProperty("cancel");
    expect(dbRead).not.toHaveBeenCalled();
    expect(secretRead).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("re-admits the live principal without decrypting a credential or making an RPC", async () => {
    const controller = await recovery();
    const secretRead = vi.spyOn(credentialSecretStore, "createCredentialSecretStore");
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(asKey(() => controller.admit())).resolves.toBeUndefined();
    expect(secretRead).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [
      "revoked key",
      "UPDATE api_keys SET status = 'revoked' WHERE id = ?",
      apiKeyId,
      "principal_not_live",
    ],
    [
      "removed grant",
      "UPDATE api_keys SET grants = '{}' WHERE id = ?",
      apiKeyId,
      "action_not_held",
    ],
    [
      "changed wallet purpose",
      "UPDATE custody_wallets SET purpose = 'fee_payer' WHERE id = ?",
      custodyWalletId,
      "wallet_purpose",
    ],
    [
      "inactive wallet",
      "UPDATE custody_wallets SET status = 'inactive' WHERE id = ?",
      custodyWalletId,
      "runtime_execution_unavailable",
    ],
    [
      "deactivated connection",
      "UPDATE custody_connections SET status = 'deactivated', deactivated_at = sdp_iso_now() WHERE id = ?",
      connectionId,
      "runtime_execution_unavailable",
    ],
    [
      "deactivated credential",
      "UPDATE provider_credentials SET status = 'deactivated', deactivated_at = sdp_iso_now() WHERE id = ?",
      credentialId,
      "provider_credential_unavailable",
    ],
    [
      "retired credential",
      "UPDATE provider_credentials SET status = 'retired' WHERE id = ?",
      credentialId,
      "provider_credential_unavailable",
    ],
    [
      "suspended organization",
      "UPDATE organizations SET status = 'suspended' WHERE id = ?",
      organizationId,
      "organization_inactive",
    ],
    [
      "changed account",
      "UPDATE custody_connections SET provider_account_fingerprint = 'different-account' WHERE id = ?",
      connectionId,
      "proposal_binding_changed",
    ],
    [
      "changed wallet",
      "UPDATE custody_wallets SET public_key = 'Vote111111111111111111111111111111111111111' WHERE id = ?",
      custodyWalletId,
      "proposal_binding_changed",
    ],
  ])("classifies %s as a durable admission refusal", async (_name, sql, id, reason) => {
    const controller = await recovery();
    await getDb(env).execute(sql, [id]);
    await expect(asKey(() => controller.admit())).rejects.toMatchObject({
      name: "ProposalAdmissionRefusedError",
      reason,
    });
  });

  it("classifies a removed provider entitlement as a durable refusal", async () => {
    const controller = await recovery();
    await getDb(env).execute("UPDATE organizations SET settings = ? WHERE id = ?", [
      JSON.stringify({ providerOverrides: { custody: { fireblocks: false } } }),
      organizationId,
    ]);
    await expect(asKey(() => controller.admit())).rejects.toMatchObject({
      name: "ProposalAdmissionRefusedError",
      reason: "provider_not_entitled",
    });
  });

  it.each([...CUSTODY_CONNECTION_CHECK_STATUSES, null])(
    "retries pending connection check %s and recovers after activation",
    async (status) => {
      const controller = await recovery();
      const secretRead = vi.spyOn(credentialSecretStore, "createCredentialSecretStore");
      const fetch = vi.spyOn(globalThis, "fetch");
      await getDb(env).execute(
        "UPDATE custody_connections SET status = 'pending', activated_at = NULL, last_check_status = ? WHERE id = ?",
        [status, connectionId]
      );
      const admission = asKey(() => controller.admit());
      await expect(admission).rejects.toMatchObject({
        code: "CONFLICT",
        details: { reason: "runtime_execution_unavailable" },
      });
      await expect(admission).rejects.not.toBeInstanceOf(ProposalAdmissionRefusedError);
      await getDb(env).execute(
        "UPDATE custody_connections SET status = 'active', activated_at = sdp_iso_now(), last_check_status = 'success' WHERE id = ?",
        [connectionId]
      );
      await expect(asKey(() => controller.admit())).resolves.toBeUndefined();
      expect(secretRead).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it("retries a release-channel configuration failure after the channel is restored", async () => {
    const controller = await recovery();
    const secretRead = vi.spyOn(credentialSecretStore, "createCredentialSecretStore");
    const fetch = vi.spyOn(globalThis, "fetch");
    testEnv.SDP_RELEASE_CHANNEL = "stable";
    const admission = asKey(() => controller.admit());
    await expect(admission).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: { reason: "custody_provider_not_in_release_channel" },
    });
    await expect(admission).rejects.not.toBeInstanceOf(ProposalAdmissionRefusedError);
    testEnv.SDP_RELEASE_CHANNEL = "beta";
    await expect(asKey(() => controller.admit())).resolves.toBeUndefined();
    expect(secretRead).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("still refuses a revoked principal while a connection check is running", async () => {
    const controller = await recovery();
    await getDb(env).execute(
      "UPDATE custody_connections SET status = 'checking', activated_at = NULL, last_check_status = 'running' WHERE id = ?",
      [connectionId]
    );
    await getDb(env).execute("UPDATE api_keys SET status = 'revoked' WHERE id = ?", [apiKeyId]);
    await expect(asKey(() => controller.admit())).rejects.toMatchObject({
      name: "ProposalAdmissionRefusedError",
      reason: "principal_not_live",
    });
  });

  it("refuses the missing principal rather than lending worker authority", async () => {
    const controller = await recovery();
    await expect(controller.admit()).rejects.toMatchObject({
      name: "ProposalAdmissionRefusedError",
      reason: "principal_missing",
    });
  });

  it("reads and cancels after organization, key, wallet and connection deactivation", async () => {
    const controller = await recovery();
    const db = getDb(env);
    await db.execute("UPDATE organizations SET status = 'suspended' WHERE id = ?", [
      organizationId,
    ]);
    await db.execute("UPDATE api_keys SET status = 'revoked' WHERE id = ?", [apiKeyId]);
    await db.execute("UPDATE custody_wallets SET status = 'inactive' WHERE id = ?", [
      custodyWalletId,
    ]);
    await db.execute(
      "UPDATE custody_connections SET status = 'deactivated', deactivated_at = sdp_iso_now() WHERE id = ?",
      [connectionId]
    );
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      expect(new Headers(init?.headers).get("X-API-Key")).toBe("retained-tenant-key");
      return Response.json(
        init?.method === "POST"
          ? { success: true }
          : {
              id: "provider-transaction",
              externalTxId: "xfr_original",
              status: "PENDING_SIGNATURE",
              operation: "TRANSFER",
              assetId: binding.assetId,
              source: { type: "VAULT_ACCOUNT", id: binding.vaultAccountId },
            }
      );
    });
    await expect(controller.read("xfr_original")).resolves.toHaveProperty(
      "id",
      "provider-transaction"
    );
    await expect(controller.cancel("xfr_original")).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[2]?.[1]?.method).toBe("POST");
  });

  it("keeps provider credential deactivation effective for retained cancellation", async () => {
    const controller = await recovery();
    await getDb(env).execute(
      "UPDATE provider_credentials SET status = 'deactivated', deactivated_at = sdp_iso_now() WHERE id = ?",
      [credentialId]
    );
    const secretRead = vi.spyOn(credentialSecretStore, "createCredentialSecretStore");
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(controller.cancel("xfr_original")).rejects.toThrow(
      "Custody Connection is unavailable"
    );
    expect(secretRead).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a different tenant before decrypting retained credentials", async () => {
    const controller = await new CustodyRuntimeTargets(
      getDb(env),
      testEnv,
      new Map()
    ).getTransferProposalRecoveryForWalletRecord(
      "another-organization",
      projectId,
      custodyWalletId,
      binding,
      "payments.transfer"
    );
    const secretRead = vi.spyOn(credentialSecretStore, "createCredentialSecretStore");
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(controller.cancel("xfr_original")).rejects.toThrow("Custody wallet");
    expect(secretRead).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not turn a transient database failure into permission to cancel", async () => {
    const controller = await recovery();
    const unavailable = new Error("database temporarily unavailable");
    vi.spyOn(getDb(env), "queryMany").mockRejectedValueOnce(unavailable);
    const admission = asKey(() => controller.admit());
    await expect(admission).rejects.toBe(unavailable);
    await expect(admission).rejects.not.toBeInstanceOf(ProposalAdmissionRefusedError);
  });
});
