import { generateKeyPairSync } from "node:crypto";
import { createCustodyProposalState } from "@sdp/types/custody-proposals";
import { MOVEMENTS } from "@sdp/types/movements";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import { generateKeyPairSigner } from "@solana/kit";
import { afterEach, aroundEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import {
  runWithoutDatabaseIdentity,
  runWithSystemDatabaseIdentity,
  runWithTenantDatabaseIdentity,
} from "@/db/identity";
import { createPostgresCustodyProposalsRepository } from "@/db/repositories/custody-proposals.repository.postgres";
import { createPostgresPaymentsRepository } from "@/db/repositories/payments.repository.postgres";
import { runAsMoneyPrincipal } from "@/lib/money-principal";
import { rootLogger } from "@/runtime/logger";
import * as credentialSecretStore from "@/services/credential-secret-store";
import { reconcilePendingProposals } from "@/services/jobs/reconcile-pending-proposals";
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
import { required } from "@/test/helpers/required";
import { seedTestDatabase } from "@/test/mocks/db";
import type { Env } from "@/types/env";
import { ProposalAdmissionRefusedError, transferProposalIntentSchema } from "./admitted-proposer";
import { CustodyRuntimeTargets } from "./custody-runtime-target";

const organizationId = "org_proposal_recovery";
const projectId = "prj_proposal_recovery";
const userId = "usr_proposal_recovery";
const apiKeyId = "key_proposal_recovery";
const custodyWalletId = "cwlt_proposal_recovery";
const connectionId = "cconn_proposal_recovery";
const credentialId = "pcred_proposal_recovery";
const { address: sourceAddress } = await generateKeyPairSigner();
const { address: otherWalletAddress } = await generateKeyPairSigner();
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
  SDP_RELEASE_CHANNEL: "experimental",
  CUSTODY_ENCRYPTION_KEY: Buffer.alloc(32, 11).toString("base64"),
  FIREBLOCKS_API_BASE_URL: "https://fireblocks.recovery.test",
};

aroundEach((runTest) =>
  runWithSystemDatabaseIdentity("cron:reconcile-custody-proposals", () => inSandboxScope(runTest))
);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

beforeEach(async () => {
  testEnv.SDP_RELEASE_CHANNEL = "experimental";
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
  it("constructs without credential reads or provider calls", async () => {
    const secretRead = vi.spyOn(credentialSecretStore, "createCredentialSecretStore");
    const fetch = vi.spyOn(globalThis, "fetch");
    await recovery();
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
  ])("classifies %s as a durable admission refusal", async (_name, sql, id, reason) => {
    const controller = await recovery();
    await getDb(env).execute(sql, [id]);
    await expect(asKey(() => controller.admit())).rejects.toMatchObject({
      name: "ProposalAdmissionRefusedError",
      reason,
    });
  });

  it("classifies a changed wallet address as a durable admission refusal", async () => {
    const controller = await recovery();
    await getDb(env).execute("UPDATE custody_wallets SET public_key = ? WHERE id = ?", [
      otherWalletAddress,
      custodyWalletId,
    ]);
    await expect(asKey(() => controller.admit())).rejects.toMatchObject({
      name: "ProposalAdmissionRefusedError",
      reason: "proposal_binding_changed",
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

  it.each(["failed", "success", null] as const)(
    "retries a pending connection whose last check is %s and recovers after activation",
    async (lastCheckStatus) => {
      const controller = await recovery();
      const secretRead = vi.spyOn(credentialSecretStore, "createCredentialSecretStore");
      const fetch = vi.spyOn(globalThis, "fetch");
      await getDb(env).execute(
        "UPDATE custody_connections SET status = 'pending', activated_at = NULL, last_check_status = ? WHERE id = ?",
        [lastCheckStatus, connectionId]
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
    testEnv.SDP_RELEASE_CHANNEL = "experimental";
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

  it("builds, reads and cancels after organization, key, wallet and connection deactivation", async () => {
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
    const controller = await recovery();
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) =>
      Response.json(
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
      )
    );
    await expect(controller.read("xfr_original")).resolves.toMatchObject({
      id: "provider-transaction",
      status: "PENDING_SIGNATURE",
    });
    await expect(controller.cancel("xfr_original")).resolves.toBe(true);
    const base = "https://fireblocks.recovery.test";
    expect(fetch.mock.calls.map(([url, init]) => [String(url), required(init).method])).toEqual([
      [`${base}/v1/transactions/external_tx_id/xfr_original`, "GET"],
      [`${base}/v1/transactions/external_tx_id/xfr_original`, "GET"],
      [`${base}/v1/transactions/provider-transaction/cancel`, "POST"],
    ]);
    for (const [, init] of fetch.mock.calls)
      expect(new Headers(required(init).headers).get("X-API-Key")).toBe("retained-tenant-key");
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

const budgetTransferId = "xfr_recovery_budget";
const budgetNow = "2026-11-23T12:00:00.000Z";
const budgetBefore = "2026-11-23T11:00:00.000Z";
const budgetIdentity = { transferId: budgetTransferId, organizationId, projectId };

async function seedBudgetProposal() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(budgetNow);
  const db = getDb(testEnv);
  const intent = transferProposalIntentSchema.parse(binding);
  await db.execute(
    `INSERT INTO payment_transfers
       (id, organization_id, project_id, custody_wallet_id, wallet_id,
        source_address, destination_address, token, amount, type, direction,
        status, created_at, updated_at, provider_data, initiated_by_principal,
        provider_reference)
     VALUES (?, ?, ?, ?, 'fb_42', ?, ?, ?, '1', 'transfer', 'outbound',
             'processing', ?, ?, ?::jsonb, ?::jsonb, 'provider-transaction')`,
    [
      budgetTransferId,
      organizationId,
      projectId,
      custodyWalletId,
      sourceAddress,
      otherWalletAddress,
      SOL_MINT,
      budgetBefore,
      budgetBefore,
      JSON.stringify({ fireblocksTransfer: intent, fireblocksStatus: "PENDING_SIGNATURE" }),
      JSON.stringify({ kind: "api_key", apiKeyId }),
    ]
  );
  const transfer = required(
    await createPostgresPaymentsRepository(db).getTransferById(budgetIdentity)
  );
  const proposals = createPostgresCustodyProposalsRepository(db);
  await proposals.ensureForTransfer({
    transfer,
    provider: "fireblocks",
    binding: { version: 1, provider: "fireblocks", ...intent },
    state: {
      ...createCustodyProposalState(),
      providerPhase: "pending",
      providerTransactionId: "provider-transaction",
      providerStatus: "PENDING_SIGNATURE",
      submissionStartedAt: budgetBefore,
    },
    now: budgetBefore,
  });
  return proposals;
}

function recoveryBudget(options: {
  status?: "PENDING_SIGNATURE" | "BROADCASTING";
  beforeRead?: () => Promise<void>;
  cancelOutcome?: "declined" | "ambiguous";
  readFailure?: Error;
}) {
  const db = getDb(testEnv);
  const warn = vi.spyOn(rootLogger, "warn");
  const ownerReads = vi.spyOn(db, "queryMany");
  const credentialReads = vi.spyOn(db, "queryOne");
  const secretReads = vi.spyOn(
    credentialSecretStore.EncryptedDbCredentialSecretStore.prototype,
    "read"
  );
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (init?.method === "POST") {
      expect(url).toBe(
        `${testEnv.FIREBLOCKS_API_BASE_URL}/v1/transactions/provider-transaction/cancel`
      );
      if (options.cancelOutcome === "ambiguous") throw new Error("Provider cancellation timed out");
      return Response.json({ success: false });
    }
    expect(url).toBe(
      `${testEnv.FIREBLOCKS_API_BASE_URL}/v1/transactions/external_tx_id/${budgetTransferId}`
    );
    await options.beforeRead?.();
    if (options.readFailure) throw options.readFailure;
    return Response.json({
      id: "provider-transaction",
      externalTxId: budgetTransferId,
      status: options.status ?? "PENDING_SIGNATURE",
      operation: "TRANSFER",
      assetId: binding.assetId,
      source: { type: "VAULT_ACCOUNT", id: binding.vaultAccountId },
    });
  });
  return {
    assert(expected: {
      owner: number;
      credential: number;
      secret: number;
      methods: string[];
      failures: number;
    }) {
      expect(
        warn.mock.calls.filter(([, message]) => message === "proposal_recovery_unavailable")
      ).toHaveLength(expected.failures);
      expect(
        ownerReads.mock.calls.filter(
          ([sql]) => sql.includes("w.wallet_id") && sql.includes("AND w.id = ?")
        )
      ).toHaveLength(expected.owner);
      expect(
        credentialReads.mock.calls.filter(([sql]) => sql.includes("pc.encrypted_secret_payload"))
      ).toHaveLength(expected.credential);
      expect(secretReads).toHaveBeenCalledTimes(expected.secret);
      // Every fetch is checked against the exact provider endpoint above. An RPC
      // or other external request would fail this assertion instead of escaping.
      expect(fetch.mock.calls.map(([, init]) => required(init).method)).toEqual(expected.methods);
    },
    clear() {
      warn.mockClear();
      ownerReads.mockClear();
      credentialReads.mockClear();
      secretReads.mockClear();
      fetch.mockClear();
    },
  };
}

describe("custody worker request budget", () => {
  it.each([
    { status: "PENDING_SIGNATURE", owner: 4, credential: 2 },
    { status: "BROADCASTING", owner: 2, credential: 1 },
  ] as const)("counts observation and admission separately for $status", async (testCase) => {
    await seedBudgetProposal();
    const budget = recoveryBudget({ status: testCase.status });
    await reconcilePendingProposals(testEnv);
    budget.assert({
      owner: testCase.owner,
      credential: testCase.credential,
      secret: 1,
      methods: ["GET"],
      failures: 0,
    });
  });

  it.each(["declined", "ambiguous"] as const)(
    "counts fresh cancellation access, cooldown observation and a retry after %s cancellation",
    async (outcome) => {
      const proposals = await seedBudgetProposal();
      await getDb(testEnv).execute("UPDATE api_keys SET status = 'revoked' WHERE id = ?", [
        apiKeyId,
      ]);
      const budget = recoveryBudget({ cancelOutcome: outcome });
      const failures = outcome === "ambiguous" ? 1 : 0;
      await reconcilePendingProposals(testEnv);
      budget.assert({
        owner: 6,
        credential: 3,
        secret: 2,
        methods: ["GET", "GET", "POST"],
        failures,
      });
      expect(
        required(await proposals.getForTransfer(budgetIdentity)).state.authorizationState
      ).toBe(outcome === "ambiguous" ? "cancel_ambiguous" : "cancel_declined");

      budget.clear();
      vi.setSystemTime(Date.parse(budgetNow) + 61_000);
      await reconcilePendingProposals(testEnv);
      budget.assert({ owner: 2, credential: 1, secret: 1, methods: ["GET"], failures: 0 });

      budget.clear();
      vi.setSystemTime(Date.parse(budgetNow) + 300_000);
      await reconcilePendingProposals(testEnv);
      budget.assert({
        owner: 4,
        credential: 2,
        secret: 2,
        methods: ["GET", "GET", "POST"],
        failures,
      });
      expect(required(await proposals.getForTransfer(budgetIdentity)).state.cancelAttempt).toBe(2);
    }
  );

  it.each([
    { revoke: false, owner: 6, credential: 3, secret: 2, methods: ["GET", "GET"], failures: 0 },
    {
      revoke: true,
      owner: 8,
      credential: 4,
      secret: 3,
      methods: ["GET", "GET", "GET", "POST"],
      failures: 0,
    },
  ])(
    "counts a fresh observation after contention before cancellation=$revoke",
    async (testCase) => {
      const proposals = await seedBudgetProposal();
      if (testCase.revoke)
        await getDb(testEnv).execute("UPDATE api_keys SET status = 'revoked' WHERE id = ?", [
          apiKeyId,
        ]);
      let conflicted = false;
      const budget = recoveryBudget({
        beforeRead: async () => {
          if (conflicted) return;
          conflicted = true;
          const proposal = required(await proposals.getForTransfer(budgetIdentity));
          expect(
            await proposals.transition({
              ...budgetIdentity,
              expectedVersion: proposal.version,
              event: {
                type: "observed",
                at: budgetNow,
                phase: "pending",
                providerTransactionId: "provider-transaction",
                providerStatus: "PENDING_SIGNATURE",
                providerSubStatus: null,
              },
            })
          ).not.toBeNull();
        },
      });
      await reconcilePendingProposals(testEnv);
      expect(conflicted).toBe(true);
      budget.assert(testCase);
    }
  );
  it("bounds an unavailable provider read without re-admission or cancellation", async () => {
    const proposals = await seedBudgetProposal();
    const budget = recoveryBudget({ readFailure: new Error("Provider read timed out") });
    await reconcilePendingProposals(testEnv);
    budget.assert({ owner: 2, credential: 1, secret: 1, methods: ["GET"], failures: 1 });
    expect(required(await proposals.getForTransfer(budgetIdentity)).state.authorizationState).toBe(
      "authorized"
    );
  });
});
