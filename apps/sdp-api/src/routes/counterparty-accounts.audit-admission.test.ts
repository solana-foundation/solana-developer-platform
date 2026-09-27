/**
 * Regression tests for APE-738 (SOLA9-540): counterparty-account mutations
 * must be admitted by the append-only audit ledger before they commit.
 *
 * Active counterparty accounts resolve as payout destinations, so a mutation
 * that commits while its audit admission fails leaves a durable destination
 * change without immutable attribution. These tests diverge the external
 * audit-ledger checkpoint — the real fail-closed admission gate, with no mocks
 * on the route or persistence layers — and assert that a caller with the
 * documented counterparties:write access gets a 500 while NOTHING becomes
 * durable and no unattributed row survives. Restoring the checkpoint must let
 * the same mutation succeed and append its audit evidence: a durable intent
 * carrying a redacted destination fingerprint and the stable pre-mutation
 * account version, plus the outcome row for the committed change.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { createKVStoreSet } from "@/runtime/kv-redis";
import { AUDIT_LEDGER_CHECKPOINT_KEY } from "@/services/audit.service";
import { TEST_API_KEY, TEST_CACHED_API_KEY } from "@/test/fixtures/api-keys";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { seedProjectApiKey } from "@/test/helpers/api-keys";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";

const TEST_PROJECT_ID = "prj_counterparty_audit_admission";
const ORIGINAL_ADDRESS = "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ";
const ATTACKER_ADDRESS = "9xQeWvG816bUx9EPfEZ8x4sQ9j6vCwLxK7wR8mN2pT1";
const authHeader = `Bearer ${TEST_API_KEY.raw}`;

interface AuditRow {
  id: string;
  resource_id: string | null;
  action: string;
  metadata: string | null;
}

async function createCounterparty(externalId: string): Promise<string> {
  const response = await app.request(
    "/v1/counterparties",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authHeader },
      body: JSON.stringify({
        entityType: "individual",
        displayName: "Audit admission regression",
        externalId,
      }),
    },
    env
  );
  expect(response.status).toBe(201);
  return (await response.json()).data.counterparty.id;
}

async function createCryptoWalletAccount(counterpartyId: string): Promise<string> {
  const response = await app.request(
    `/v1/counterparties/${counterpartyId}/accounts`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authHeader },
      body: JSON.stringify({
        accountKind: "crypto_wallet",
        label: "Reusable payout wallet",
        details: { network: "solana", address: ORIGINAL_ADDRESS },
      }),
    },
    env
  );
  expect(response.status).toBe(201);
  return (await response.json()).data.account.id;
}

/**
 * Replaces the valid external checkpoint with an impossible-but-well-formed
 * one, capturing the valid value for restoration. Audit admission fails closed
 * for every subsequent writer.
 */
async function divergeCheckpoint(): Promise<string> {
  const kv = createKVStoreSet(env);
  const validCheckpoint = await kv.cache.get(AUDIT_LEDGER_CHECKPOINT_KEY);
  expect(validCheckpoint).toMatch(/^\{"sequence":\d+,"headHash":"[0-9a-f]{64}"\}$/);
  await kv.cache.put(
    AUDIT_LEDGER_CHECKPOINT_KEY,
    JSON.stringify({ sequence: 1, headHash: "0".repeat(64) })
  );
  return validCheckpoint as string;
}

async function accountRows(counterpartyId: string) {
  return getDb(env)
    .prepare(
      "SELECT id, status, address, details FROM counterparty_accounts WHERE counterparty_id = ?"
    )
    .bind(counterpartyId)
    .all<{
      id: string;
      status: string;
      address: string | null;
      details: Record<string, unknown>;
    }>();
}

async function accountAuditRows(accountId: string, action: string): Promise<AuditRow[]> {
  const result = await getDb(env)
    .prepare(
      `SELECT id, resource_id, action, metadata FROM audit_logs
       WHERE resource_type = 'counterparty_account'
         AND resource_id = ?
         AND action = ?`
    )
    .bind(accountId, action)
    .all<AuditRow>();
  return result.results;
}

async function ledgerIntentRows(): Promise<AuditRow[]> {
  const result = await getDb(env)
    .prepare(
      `SELECT id, resource_id, action, metadata FROM audit_logs
       WHERE resource_type = 'audit_ledger' AND action = 'maintenance'`
    )
    .all<AuditRow>();
  return result.results;
}

describe("Counterparty account audit admission ordering (APE-738)", () => {
  beforeAll(async () => {
    await seedTestDatabase(env);
  });

  afterAll(async () => {
    await seedTestDatabase(env);
  });

  beforeEach(async () => {
    await seedTestDatabase(env);
    const db = getDb(env);
    const kv = createKVStoreSet(env);

    await db
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
      .run();
    await db
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(TEST_USER.id, TEST_USER.email)
      .run();
    await seedDefaultProjects(db, {
      organizationId: TEST_ORG.id,
      createdBy: TEST_USER.id,
      members: [TEST_USER.id],
      ids: { sandbox: TEST_PROJECT_ID, production: `${TEST_PROJECT_ID}_production` },
    });
    const keyHash = await seedProjectApiKey(db, env, {
      key: TEST_API_KEY,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      createdBy: TEST_USER.id,
      role: "api_admin",
      permissions: ["*"],
    });
    await kv.apiKeys.put(
      `key:${keyHash}`,
      JSON.stringify({ ...TEST_CACHED_API_KEY, projectId: TEST_PROJECT_ID })
    );
  });

  it("PATCH keeps the original destination when audit admission fails", async () => {
    const counterpartyId = await createCounterparty("audit_admission_patch");
    const accountId = await createCryptoWalletAccount(counterpartyId);

    const validCheckpoint = await divergeCheckpoint();

    const failedMutation = await app.request(
      `/v1/counterparties/${counterpartyId}/accounts/${accountId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({
          details: { network: "solana", address: ATTACKER_ADDRESS },
        }),
      },
      env
    );
    expect(failedMutation.status).toBe(500);

    // The destination change must not be durable: the account row and its
    // denormalized lookup columns keep the original address.
    const rows = await accountRows(counterpartyId);
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0].details).toEqual({ network: "solana", address: ORIGINAL_ADDRESS });
    expect(rows.results[0].address).toBe(ORIGINAL_ADDRESS);

    // No update event was admitted, so none may exist for the account.
    expect(await accountAuditRows(accountId, "update")).toHaveLength(0);

    // Negative control: with the checkpoint restored, the same rotation the
    // admission failure refused now commits together with its append-only
    // update event — and the attempted destination actually persists.
    const kv = createKVStoreSet(env);
    await kv.cache.put(AUDIT_LEDGER_CHECKPOINT_KEY, validCheckpoint);
    const successfulMutation = await app.request(
      `/v1/counterparties/${counterpartyId}/accounts/${accountId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({
          details: { network: "solana", address: ATTACKER_ADDRESS },
        }),
      },
      env
    );
    expect(successfulMutation.status).toBe(200);
    expect((await successfulMutation.json()).data.account.details).toEqual({
      network: "solana",
      address: ATTACKER_ADDRESS,
    });
    const rotatedRows = await accountRows(counterpartyId);
    expect(rotatedRows.results).toHaveLength(1);
    expect(rotatedRows.results[0].details).toEqual({
      network: "solana",
      address: ATTACKER_ADDRESS,
    });
    expect(rotatedRows.results[0].address).toBe(ATTACKER_ADDRESS);
    expect(await accountAuditRows(accountId, "update")).toHaveLength(1);
  });

  it("POST creates no account when audit admission fails", async () => {
    const counterpartyId = await createCounterparty("audit_admission_create");

    const validCheckpoint = await divergeCheckpoint();

    const failedCreate = await app.request(
      `/v1/counterparties/${counterpartyId}/accounts`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({
          accountKind: "crypto_wallet",
          label: "Unattributed wallet",
          details: { network: "solana", address: ATTACKER_ADDRESS },
        }),
      },
      env
    );
    expect(failedCreate.status).toBe(500);

    const rows = await accountRows(counterpartyId);
    expect(rows.results).toHaveLength(0);

    // Negative control: the same create succeeds once admission works.
    const kv = createKVStoreSet(env);
    await kv.cache.put(AUDIT_LEDGER_CHECKPOINT_KEY, validCheckpoint);
    const successfulCreate = await app.request(
      `/v1/counterparties/${counterpartyId}/accounts`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({
          accountKind: "crypto_wallet",
          label: "Unattributed wallet",
          details: { network: "solana", address: ATTACKER_ADDRESS },
        }),
      },
      env
    );
    expect(successfulCreate.status).toBe(201);
    const accountId = (await successfulCreate.json()).data.account.id;
    expect(await accountAuditRows(accountId, "create")).toHaveLength(1);

    // The durable intent pins the account's identity, not just its
    // destination fingerprint: two accounts under the same counterparty can
    // share a destination, so the intent must name the account it admitted.
    const createIntents = await ledgerIntentRows();
    const createIntent = createIntents
      .map((row) => ({ row, metadata: row.metadata ? JSON.parse(row.metadata) : null }))
      .find(
        (candidate) =>
          candidate.metadata?.auditPhase === "intent" &&
          candidate.metadata?.target?.action === "create" &&
          candidate.metadata?.target?.resourceId === accountId
      );
    expect(createIntent).toBeDefined();
    expect(createIntent?.metadata?.target?.metadata?.destinationFingerprint).toMatch(
      /^[0-9a-f]{64}$/
    );
  });

  it("DELETE keeps the account active when audit admission fails", async () => {
    const counterpartyId = await createCounterparty("audit_admission_archive");
    const accountId = await createCryptoWalletAccount(counterpartyId);

    const validCheckpoint = await divergeCheckpoint();

    const failedArchive = await app.request(
      `/v1/counterparties/${counterpartyId}/accounts/${accountId}`,
      { method: "DELETE", headers: { Authorization: authHeader } },
      env
    );
    expect(failedArchive.status).toBe(500);

    const rows = await accountRows(counterpartyId);
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0].status).toBe("active");

    // Negative control: the same archive succeeds once admission works.
    const kv = createKVStoreSet(env);
    await kv.cache.put(AUDIT_LEDGER_CHECKPOINT_KEY, validCheckpoint);
    const successfulArchive = await app.request(
      `/v1/counterparties/${counterpartyId}/accounts/${accountId}`,
      { method: "DELETE", headers: { Authorization: authHeader } },
      env
    );
    expect(successfulArchive.status).toBe(204);
    const archivedRows = await accountRows(counterpartyId);
    expect(archivedRows.results[0].status).toBe("archived");
    expect(await accountAuditRows(accountId, "delete")).toHaveLength(1);
  });

  it("commits a successful update with intent and outcome evidence pinning the version and a redacted destination fingerprint", async () => {
    const counterpartyId = await createCounterparty("audit_admission_evidence");
    const accountId = await createCryptoWalletAccount(counterpartyId);

    const preMutation = await getDb(env)
      .prepare("SELECT updated_at FROM counterparty_accounts WHERE id = ?")
      .bind(accountId)
      .first<{ updated_at: string }>();
    expect(preMutation).not.toBeNull();

    const response = await app.request(
      `/v1/counterparties/${counterpartyId}/accounts/${accountId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({
          label: "Rotated payout wallet",
          details: { network: "solana", address: ATTACKER_ADDRESS },
        }),
      },
      env
    );
    expect(response.status).toBe(200);

    const intents = await ledgerIntentRows();
    const intent = intents
      .map((row) => ({ row, metadata: row.metadata ? JSON.parse(row.metadata) : null }))
      .find(
        (candidate) =>
          candidate.metadata?.auditPhase === "intent" &&
          candidate.metadata?.target?.action === "update" &&
          candidate.metadata?.target?.resourceId === accountId
      );
    expect(intent).toBeDefined();
    const intentEvidence = intent?.metadata?.target?.metadata;
    // The destination is attributed through a redacted fingerprint, never the
    // raw address, and the evidence pins the pre-mutation account version.
    expect(intentEvidence.destinationFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(intentEvidence.destinationFingerprint).not.toContain(ATTACKER_ADDRESS);
    expect(intentEvidence.previousDestinationFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(intentEvidence.accountVersion).toBe(preMutation?.updated_at);
    expect(intentEvidence.changedFields).toEqual(["label", "details"]);

    const outcomes = await accountAuditRows(accountId, "update");
    expect(outcomes).toHaveLength(1);
    const outcomeMetadata = outcomes[0].metadata ? JSON.parse(outcomes[0].metadata) : null;
    expect(outcomeMetadata.auditPhase).toBe("outcome");
    expect(outcomeMetadata.auditIntentId).toBe(intent?.row.resource_id);
  });
});
