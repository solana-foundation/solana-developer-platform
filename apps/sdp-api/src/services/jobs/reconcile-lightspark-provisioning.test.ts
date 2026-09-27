import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { getDb } from "@/db";
import { createPostgresCounterpartiesRepository } from "@/db/repositories/counterparty.repository.postgres";
import { createPostgresCounterpartyProviderAccountsRepository } from "@/db/repositories/counterparty-provider-account.repository.postgres";
import type { KVStore, SlidingWindowAdmission, SlidingWindowOptions } from "@/runtime/kv";
import { AuditService } from "@/services/audit.service";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import {
  LIGHTSPARK_PROVISIONING_RECONCILE_BATCH,
  LIGHTSPARK_PROVISIONING_RECONCILE_GRACE_MS,
  reconcileLightsparkProvisioning,
} from "./reconcile-lightspark-provisioning";

const TEST_PROJECT_ID = "prj_lightspark_reconcile";

/** In-memory external checkpoint store, mirroring the audit integration harness. */
class MemoryCheckpointStore implements KVStore {
  private value: string | null = null;

  get(_key: string): Promise<string | null>;
  get<T>(_key: string, _type: "json"): Promise<T | null>;
  async get<T>(_key: string, type?: "json"): Promise<string | T | null> {
    if (this.value === null) return null;
    return type === "json" ? (JSON.parse(this.value) as T) : this.value;
  }

  async put(_key: string, value: string): Promise<void> {
    this.value = value;
  }

  async delete(): Promise<void> {
    this.value = null;
  }

  async compareAndSet(_key: string, expected: string | null, value: string): Promise<boolean> {
    if (this.value !== expected) return false;
    this.value = value;
    return true;
  }

  async compareAndDelete(_key: string, expected: string): Promise<boolean> {
    if (this.value !== expected) return false;
    this.value = null;
    return true;
  }

  async list() {
    return { keys: [] };
  }

  async admitSlidingWindow(
    _currentKey: string,
    _previousKey: string,
    _options: SlidingWindowOptions
  ): Promise<SlidingWindowAdmission> {
    throw new Error("not implemented by the lightspark reconcile test store");
  }
}

describe("reconcileLightsparkProvisioning", () => {
  let fetchSpy: MockInstance | undefined;

  beforeEach(async () => {
    await seedTestDatabase(env);
    const db = getDb(env);
    await db.prepare("DELETE FROM counterparty_provider_accounts").run();
    await db.prepare("DELETE FROM counterparties").run();
    await db.prepare("DELETE FROM projects").run();
    await db
      .prepare(
        "INSERT OR REPLACE INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
      .run();
    await db
      .prepare(
        "INSERT OR REPLACE INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')"
      )
      .bind(TEST_USER.id, TEST_USER.email)
      .run();
    await seedDefaultProjects(db, {
      organizationId: TEST_ORG.id,
      createdBy: TEST_USER.id,
      members: [],
      ids: { sandbox: TEST_PROJECT_ID, production: `${TEST_PROJECT_ID}_production` },
    });
    env.LIGHTSPARK_GRID_SANDBOX_CLIENT_ID = "lightspark_client_id";
    env.LIGHTSPARK_GRID_SANDBOX_CLIENT_SECRET = "lightspark_client_secret";
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = undefined;
    env.LIGHTSPARK_GRID_SANDBOX_CLIENT_ID = undefined;
    env.LIGHTSPARK_GRID_SANDBOX_CLIENT_SECRET = undefined;
    vi.restoreAllMocks();
  });

  const accounts = () => createPostgresCounterpartyProviderAccountsRepository(getDb(env));

  async function seedCounterparty(externalId: string) {
    const counterparty = await createPostgresCounterpartiesRepository(
      getDb(env)
    ).createCounterparty({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      externalId,
      entityType: "individual",
      displayName: "Ada Lovelace",
      providerData: {},
      createdBy: TEST_USER.id,
    });
    if (counterparty === null) {
      throw new Error("counterparty fixture was not created");
    }
    return counterparty;
  }

  async function seedPendingRow(counterpartyId: string, customerReference: string) {
    const row = await accounts().insertPendingExternalAccount({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId,
      provider: "lightspark",
      providerCustomerReference: customerReference,
      fiatCurrency: "USD",
      destinationCountry: "US",
      paymentRail: "ACH",
    });
    await getDb(env)
      .prepare(
        "UPDATE counterparty_provider_accounts SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?"
      )
      .bind(row.id)
      .run();
    return row;
  }

  /** Writes an unresolved provisioning intent through the real system writer. */
  async function seedUnresolvedIntent(input: {
    counterpartyId: string;
    action: string;
    metadata: Record<string, unknown>;
  }): Promise<string> {
    const audit = new AuditService(getDb(env), new MemoryCheckpointStore());
    const intent = await audit.beginCriticalSystem({
      organizationId: TEST_ORG.id,
      action: "update",
      resourceType: "counterparty",
      resourceId: input.counterpartyId,
      metadata: { action: input.action, provider: "lightspark", ...input.metadata },
    });
    return intent.id;
  }

  async function unresolvedIntentCount(intentId: string): Promise<number> {
    const row = await getDb(env)
      .prepare(
        `SELECT count(*)::integer AS count FROM audit_logs
         WHERE resource_type = 'audit_ledger'
           AND metadata::jsonb ->> 'auditPhase' = 'intent'
           AND resource_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM audit_logs o
             WHERE o.metadata::jsonb ->> 'auditPhase' = 'outcome'
               AND o.metadata::jsonb ->> 'auditIntentId' = ?
           )`
      )
      .bind(intentId, intentId)
      .first<{ count: number }>();
    return row?.count ?? 0;
  }

  it("repairs an orphaned provider payout account into its pending reservation", async () => {
    const counterparty = await seedCounterparty("ls_reconcile_repair");
    const row = await seedPendingRow(counterparty.id, "Customer:reconcile_repair");
    const intentId = await seedUnresolvedIntent({
      counterpartyId: counterparty.id,
      action: "lightspark_payout_account_created",
      metadata: {
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        localRowId: row.id,
        providerCustomerReference: "Customer:reconcile_repair",
        corridor: { fiatCurrency: "USD", destinationCountry: "US", paymentRail: "ACH" },
        effect: { kind: "payout_account", platformAccountId: row.id },
      },
    });

    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/customers/external-accounts")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "ExternalAccount:recovered",
                platformAccountId: row.id,
                status: "ACTIVE",
                accountInfo: { accountType: "USD_ACCOUNT", paymentRails: ["ACH"] },
              },
            ],
            hasMore: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      throw new Error(`unexpected fetch: ${path}`);
    });

    const touched = await reconcileLightsparkProvisioning(env, { graceMs: 0 });
    expect(touched).toBe(1);

    const repaired = await accounts().getExternalAccountById({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "lightspark",
      id: row.id,
    });
    expect(repaired?.external_account_reference).toBe("ExternalAccount:recovered");
    expect(repaired?.provider_status).toBe("ACTIVE");

    const outcome = await getDb(env)
      .prepare(
        `SELECT status, metadata::jsonb AS metadata FROM audit_logs
         WHERE metadata::jsonb ->> 'auditPhase' = 'outcome'
           AND metadata::jsonb ->> 'auditIntentId' = ?`
      )
      .bind(intentId)
      .first<{ status: string; metadata: Record<string, unknown> }>();
    expect(outcome?.status).toBe("success");
    expect(outcome?.metadata).toMatchObject({
      reconciledBy: "lightspark_provisioning_reconciler",
      externalAccountReference: "ExternalAccount:recovered",
    });
    await expect(unresolvedIntentCount(intentId)).resolves.toBe(0);
  });

  it("flags a stale reservation the provider never received and fails its intent", async () => {
    const counterparty = await seedCounterparty("ls_reconcile_flag");
    const row = await seedPendingRow(counterparty.id, "Customer:reconcile_flag");
    const intentId = await seedUnresolvedIntent({
      counterpartyId: counterparty.id,
      action: "lightspark_payout_account_created",
      metadata: {
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        localRowId: row.id,
        providerCustomerReference: "Customer:reconcile_flag",
        corridor: { fiatCurrency: "USD", destinationCountry: "US", paymentRail: "ACH" },
        effect: { kind: "payout_account", platformAccountId: row.id },
      },
    });

    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/customers/external-accounts")) {
        return new Response(JSON.stringify({ data: [], hasMore: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${path}`);
    });

    const touched = await reconcileLightsparkProvisioning(env, { graceMs: 0 });
    expect(touched).toBe(1);

    const flagged = await accounts().getExternalAccountById({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "lightspark",
      id: row.id,
    });
    expect(flagged?.status).toBe("archived");

    const outcome = await getDb(env)
      .prepare(
        `SELECT status, metadata::jsonb AS metadata FROM audit_logs
         WHERE metadata::jsonb ->> 'auditPhase' = 'outcome'
           AND metadata::jsonb ->> 'auditIntentId' = ?`
      )
      .bind(intentId)
      .first<{ status: string; metadata: Record<string, unknown> }>();
    expect(outcome?.status).toBe("failure");
    expect(outcome?.metadata).toMatchObject({
      reconciledBy: "lightspark_provisioning_reconciler",
      providerOutcome: "unverified",
      providerAccountFound: false,
    });
  });

  it("resolves a payout intent whose row completed after its outcome write failed", async () => {
    const counterparty = await seedCounterparty("ls_reconcile_completed");
    const row = await seedPendingRow(counterparty.id, "Customer:reconcile_completed");
    await accounts().completeExternalAccount({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "lightspark",
      id: row.id,
      externalAccountReference: "ExternalAccount:reconcile_completed",
      providerStatus: "ACTIVE",
    });
    const intentId = await seedUnresolvedIntent({
      counterpartyId: counterparty.id,
      action: "lightspark_payout_account_created",
      metadata: {
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        localRowId: row.id,
        providerCustomerReference: "Customer:reconcile_completed",
        corridor: { fiatCurrency: "USD", destinationCountry: "US", paymentRail: "ACH" },
        effect: { kind: "payout_account", platformAccountId: row.id },
      },
    });

    // The completed row is decided from local state alone: no provider call.
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      throw new Error(`no provider call may run for a completed row: ${String(input)}`);
    });

    const touched = await reconcileLightsparkProvisioning(env, { graceMs: 0 });
    expect(touched).toBe(1);

    const outcome = await getDb(env)
      .prepare(
        `SELECT status, metadata::jsonb AS metadata FROM audit_logs
         WHERE metadata::jsonb ->> 'auditPhase' = 'outcome'
           AND metadata::jsonb ->> 'auditIntentId' = ?`
      )
      .bind(intentId)
      .first<{ status: string; metadata: Record<string, unknown> }>();
    expect(outcome?.status).toBe("success");
    expect(outcome?.metadata).toMatchObject({
      reconciledBy: "lightspark_provisioning_reconciler",
      externalAccountReference: "ExternalAccount:reconcile_completed",
    });
    await expect(unresolvedIntentCount(intentId)).resolves.toBe(0);
  });

  it("detects an orphaned provider account behind an archived reservation", async () => {
    const counterparty = await seedCounterparty("ls_reconcile_orphan");
    const row = await seedPendingRow(counterparty.id, "Customer:reconcile_orphan");
    await accounts().archiveExternalAccount({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "lightspark",
      id: row.id,
    });
    const intentId = await seedUnresolvedIntent({
      counterpartyId: counterparty.id,
      action: "lightspark_payout_account_created",
      metadata: {
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        localRowId: row.id,
        providerCustomerReference: "Customer:reconcile_orphan",
        corridor: { fiatCurrency: "USD", destinationCountry: "US", paymentRail: "ACH" },
        effect: { kind: "payout_account", platformAccountId: row.id },
      },
    });

    // The provider did receive the account before the local completion failed
    // and the request archived its reservation: the sweep must detect the
    // orphan instead of recording a false absence.
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/customers/external-accounts")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "ExternalAccount:orphaned",
                platformAccountId: row.id,
                status: "ACTIVE",
                accountInfo: { accountType: "USD_ACCOUNT", paymentRails: ["ACH"] },
              },
            ],
            hasMore: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      throw new Error(`unexpected fetch: ${path}`);
    });

    const touched = await reconcileLightsparkProvisioning(env, { graceMs: 0 });
    expect(touched).toBe(1);

    const outcome = await getDb(env)
      .prepare(
        `SELECT status, metadata::jsonb AS metadata FROM audit_logs
         WHERE metadata::jsonb ->> 'auditPhase' = 'outcome'
           AND metadata::jsonb ->> 'auditIntentId' = ?`
      )
      .bind(intentId)
      .first<{ status: string; metadata: Record<string, unknown> }>();
    expect(outcome?.status).toBe("failure");
    expect(outcome?.metadata).toMatchObject({
      reconciledBy: "lightspark_provisioning_reconciler",
      providerAccountFound: true,
      orphanedProviderAccount: true,
      externalAccountReference: "ExternalAccount:orphaned",
      providerStatus: "ACTIVE",
    });
    await expect(unresolvedIntentCount(intentId)).resolves.toBe(0);
  });

  it("verifies the absence behind an archived reservation before failing its intent", async () => {
    const counterparty = await seedCounterparty("ls_reconcile_archived_absent");
    const row = await seedPendingRow(counterparty.id, "Customer:reconcile_archived_absent");
    await accounts().archiveExternalAccount({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "lightspark",
      id: row.id,
    });
    const intentId = await seedUnresolvedIntent({
      counterpartyId: counterparty.id,
      action: "lightspark_payout_account_created",
      metadata: {
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        localRowId: row.id,
        providerCustomerReference: "Customer:reconcile_archived_absent",
        corridor: { fiatCurrency: "USD", destinationCountry: "US", paymentRail: "ACH" },
        effect: { kind: "payout_account", platformAccountId: row.id },
      },
    });

    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/customers/external-accounts")) {
        return new Response(JSON.stringify({ data: [], hasMore: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${path}`);
    });

    const touched = await reconcileLightsparkProvisioning(env, { graceMs: 0 });
    expect(touched).toBe(1);

    const outcome = await getDb(env)
      .prepare(
        `SELECT status, metadata::jsonb AS metadata FROM audit_logs
         WHERE metadata::jsonb ->> 'auditPhase' = 'outcome'
           AND metadata::jsonb ->> 'auditIntentId' = ?`
      )
      .bind(intentId)
      .first<{ status: string; metadata: Record<string, unknown> }>();
    expect(outcome?.status).toBe("failure");
    expect(outcome?.metadata).toMatchObject({
      reconciledBy: "lightspark_provisioning_reconciler",
      providerOutcome: "verified",
      providerAccountFound: false,
    });
    await expect(unresolvedIntentCount(intentId)).resolves.toBe(0);
  });

  it("resolves newer completed-payout intents while an outage pins the pending ones", async () => {
    // A full oldest-first batch of stale reservations a provider outage leaves
    // untriageable must not starve newer intents whose rows completed locally.
    for (let index = 0; index < LIGHTSPARK_PROVISIONING_RECONCILE_BATCH; index += 1) {
      const staleCounterparty = await seedCounterparty(`ls_reconcile_starve_${index}`);
      const staleRow = await seedPendingRow(staleCounterparty.id, `Customer:starve_${index}`);
      await seedUnresolvedIntent({
        counterpartyId: staleCounterparty.id,
        action: "lightspark_payout_account_created",
        metadata: {
          organizationId: TEST_ORG.id,
          projectId: TEST_PROJECT_ID,
          counterpartyId: staleCounterparty.id,
          localRowId: staleRow.id,
          providerCustomerReference: `Customer:starve_${index}`,
          corridor: { fiatCurrency: "USD", destinationCountry: "US", paymentRail: "ACH" },
          effect: { kind: "payout_account", platformAccountId: staleRow.id },
        },
      });
    }
    // The stale intents above were admitted first, so they fill the batch's
    // oldest-first window; the completed intent below lands one position past
    // the batch limit.

    const counterparty = await seedCounterparty("ls_reconcile_starved_completed");
    const row = await seedPendingRow(counterparty.id, "Customer:starved_completed");
    await accounts().completeExternalAccount({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "lightspark",
      id: row.id,
      externalAccountReference: "ExternalAccount:starved_completed",
      providerStatus: "ACTIVE",
    });
    const intentId = await seedUnresolvedIntent({
      counterpartyId: counterparty.id,
      action: "lightspark_payout_account_created",
      metadata: {
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        localRowId: row.id,
        providerCustomerReference: "Customer:starved_completed",
        corridor: { fiatCurrency: "USD", destinationCountry: "US", paymentRail: "ACH" },
        effect: { kind: "payout_account", platformAccountId: row.id },
      },
    });

    // The outage fails every provider lookup, so the stale reservations cannot
    // be triaged; the completed row resolves from local state alone.
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      throw new Error(`provider outage: ${String(input)}`);
    });

    const touched = await reconcileLightsparkProvisioning(env, { graceMs: 0 });
    expect(touched).toBe(1);

    const outcome = await getDb(env)
      .prepare(
        `SELECT status, metadata::jsonb AS metadata FROM audit_logs
         WHERE metadata::jsonb ->> 'auditPhase' = 'outcome'
           AND metadata::jsonb ->> 'auditIntentId' = ?`
      )
      .bind(intentId)
      .first<{ status: string; metadata: Record<string, unknown> }>();
    expect(outcome?.status).toBe("success");
    expect(outcome?.metadata).toMatchObject({
      reconciledBy: "lightspark_provisioning_reconciler",
      externalAccountReference: "ExternalAccount:starved_completed",
    });
    await expect(unresolvedIntentCount(intentId)).resolves.toBe(0);
  });

  it("does not archive a reservation that completes while the provider lookup is in flight", async () => {
    const counterparty = await seedCounterparty("ls_reconcile_race");
    const row = await seedPendingRow(counterparty.id, "Customer:reconcile_race");
    const intentId = await seedUnresolvedIntent({
      counterpartyId: counterparty.id,
      action: "lightspark_payout_account_created",
      metadata: {
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        localRowId: row.id,
        providerCustomerReference: "Customer:reconcile_race",
        corridor: { fiatCurrency: "USD", destinationCountry: "US", paymentRail: "ACH" },
        effect: { kind: "payout_account", platformAccountId: row.id },
      },
    });

    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/customers/external-accounts")) {
        // The racing request binds its provider account while the sweep waits
        // on the lookup, so the sweep's later archive must refuse to run.
        await accounts().completeExternalAccount({
          organizationId: TEST_ORG.id,
          projectId: TEST_PROJECT_ID,
          counterpartyId: counterparty.id,
          provider: "lightspark",
          id: row.id,
          externalAccountReference: "ExternalAccount:reconcile_race",
          providerStatus: "ACTIVE",
        });
        return new Response(JSON.stringify({ data: [], hasMore: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${path}`);
    });

    const touched = await reconcileLightsparkProvisioning(env, { graceMs: 0 });
    expect(touched).toBe(1);

    const raced = await accounts().getExternalAccountById({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "lightspark",
      id: row.id,
    });
    expect(raced?.status).toBe("active");
    expect(raced?.external_account_reference).toBe("ExternalAccount:reconcile_race");

    const outcome = await getDb(env)
      .prepare(
        `SELECT status, metadata::jsonb AS metadata FROM audit_logs
         WHERE metadata::jsonb ->> 'auditPhase' = 'outcome'
           AND metadata::jsonb ->> 'auditIntentId' = ?`
      )
      .bind(intentId)
      .first<{ status: string; metadata: Record<string, unknown> }>();
    expect(outcome?.status).toBe("success");
    expect(outcome?.metadata).toMatchObject({
      reconciledBy: "lightspark_provisioning_reconciler",
      externalAccountReference: "ExternalAccount:reconcile_race",
    });
  });

  it("links an orphaned provider customer and resolves its unresolved intent", async () => {
    const counterparty = await seedCounterparty("ls_reconcile_customer");
    const intentId = await seedUnresolvedIntent({
      counterpartyId: counterparty.id,
      action: "lightspark_customer_created",
      metadata: {
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        effect: {
          kind: "customer_link",
          platformCustomerId: counterparty.id,
          customerType: "INDIVIDUAL",
        },
      },
    });

    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/customers")) {
        return new Response(JSON.stringify({ data: [{ id: "Customer:recovered_customer" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${path}`);
    });

    const touched = await reconcileLightsparkProvisioning(env, { graceMs: 0 });
    expect(touched).toBe(1);

    const linked = await accounts().getProviderAccount({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "lightspark",
    });
    expect(linked?.provider_customer_reference).toBe("Customer:recovered_customer");

    const outcome = await getDb(env)
      .prepare(
        `SELECT status, metadata::jsonb AS metadata FROM audit_logs
         WHERE metadata::jsonb ->> 'auditPhase' = 'outcome'
           AND metadata::jsonb ->> 'auditIntentId' = ?`
      )
      .bind(intentId)
      .first<{ status: string; metadata: Record<string, unknown> }>();
    expect(outcome?.status).toBe("success");
    expect(outcome?.metadata).toMatchObject({
      reconciledBy: "lightspark_provisioning_reconciler",
      providerCustomerReference: "Customer:recovered_customer",
    });
  });

  it("leaves fresh reservations and intents alone inside the grace window", async () => {
    const counterparty = await seedCounterparty("ls_reconcile_fresh");
    const row = await accounts().insertPendingExternalAccount({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "lightspark",
      providerCustomerReference: "Customer:reconcile_fresh",
      fiatCurrency: "USD",
      destinationCountry: "US",
      paymentRail: "ACH",
    });
    const intentId = await seedUnresolvedIntent({
      counterpartyId: counterparty.id,
      action: "lightspark_payout_account_created",
      metadata: {
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        localRowId: row.id,
        providerCustomerReference: "Customer:reconcile_fresh",
        corridor: { fiatCurrency: "USD", destinationCountry: "US", paymentRail: "ACH" },
        effect: { kind: "payout_account", platformAccountId: row.id },
      },
    });

    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("no provider call may run inside the grace window");
    });

    const touched = await reconcileLightsparkProvisioning(env);
    expect(touched).toBe(0);
    await expect(unresolvedIntentCount(intentId)).resolves.toBe(1);
    const fresh = await accounts().getExternalAccountById({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      counterpartyId: counterparty.id,
      provider: "lightspark",
      id: row.id,
    });
    expect(fresh?.status).toBe("active");
    expect(fresh?.external_account_reference).toBeNull();
    expect(LIGHTSPARK_PROVISIONING_RECONCILE_GRACE_MS).toBeGreaterThan(0);
  });

  it("keeps the sweep idempotent once every candidate is resolved", async () => {
    const counterparty = await seedCounterparty("ls_reconcile_idempotent");
    const row = await seedPendingRow(counterparty.id, "Customer:reconcile_idem");
    await seedUnresolvedIntent({
      counterpartyId: counterparty.id,
      action: "lightspark_payout_account_created",
      metadata: {
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        counterpartyId: counterparty.id,
        localRowId: row.id,
        providerCustomerReference: "Customer:reconcile_idem",
        corridor: { fiatCurrency: "USD", destinationCountry: "US", paymentRail: "ACH" },
        effect: { kind: "payout_account", platformAccountId: row.id },
      },
    });
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/customers/external-accounts")) {
        return new Response(JSON.stringify({ data: [], hasMore: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${path}`);
    });

    await reconcileLightsparkProvisioning(env, { graceMs: 0 });
    const secondPass = await reconcileLightsparkProvisioning(env, { graceMs: 0 });
    expect(secondPass).toBe(0);
    expect(RAMP_PROVIDER_CLIENTS.lightspark).toBeDefined();
  });
});
