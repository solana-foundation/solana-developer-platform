import { createSign, generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { createPostgresRampWebhookEventsRepository } from "@/db/repositories/ramp-webhook-event.repository";
import { MuralWebhookProcessor } from "@/routes/webhooks/ramps/mural";
import { applyStoredRampWebhookEvent } from "@/services/jobs/replay-ramp-webhook-events";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";

/**
 * Regression test for SOLA9-580: a signed Mural KYC/TOS lifecycle webhook
 * mutates the counterparty and normalized KYC wallet state, then its durable
 * inbox row is deleted — so without an audit-ledger admission the compliance
 * decision is attributable only to mutable state. The secure behavior under
 * test: the lifecycle mutation is admitted to the append-only audit ledger
 * (durable intent before the write, outcome after), keyed by the provider
 * event binding and the mutation scope, and a failed admission aborts the
 * mutable write.
 */

interface AuditRow {
  action: string;
  resource_type: string;
  resource_id: string | null;
  metadata: string | null;
  request_id: string | null;
  status: string;
}

function parseMetadata(row: AuditRow): Record<string, unknown> {
  return row.metadata === null ? {} : (JSON.parse(row.metadata) as Record<string, unknown>);
}

/** The one row a filter must produce; fails the test with the list length otherwise. */
function sole<T>(rows: T[]): T {
  expect(rows).toHaveLength(1);
  return rows[0] as T;
}

async function readAuditRows(organizationId: string): Promise<AuditRow[]> {
  const result = await getDb(env)
    .prepare(
      `SELECT action, resource_type, resource_id, metadata, request_id, status
         FROM audit_logs
        WHERE organization_id = ?
        ORDER BY ledger_sequence ASC`
    )
    .bind(organizationId)
    .all<Record<string, unknown>>();
  return result.results.map((row) => ({
    action: row.action as string,
    resource_type: row.resource_type as string,
    resource_id: (row.resource_id as string | null) ?? null,
    metadata: (row.metadata as string | null) ?? null,
    request_id: (row.request_id as string | null) ?? null,
    status: row.status as string,
  }));
}

describe("Mural lifecycle webhook audit admission (SOLA9-580)", () => {
  const organizationId = "org_mural_audit_regression";
  const projectId = "prj_mural_audit_regression";
  const userId = "usr_mural_audit_regression";
  const counterpartyId = "cp_mural_audit_regression";
  const muralOrganizationId = "mural_org_audit_regression";
  const kycWalletId = "kyc_mural_audit_regression";
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  beforeEach(async () => {
    await seedTestDatabase(env);
    env.MURAL_PAY_SANDBOX_WEBHOOK_PUBLIC_KEY = publicKey;

    await getDb(env).batch([
      getDb(env)
        .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
        .bind(
          organizationId,
          "Mural Audit Regression",
          "mural-audit-regression",
          "enterprise",
          "active"
        ),
      getDb(env)
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
        .bind(userId, "mural-audit-regression@example.com", 1, "active"),
    ]);
    await seedDefaultProjects(getDb(env), {
      organizationId,
      createdBy: userId,
      members: [],
      ids: { sandbox: projectId, production: `${projectId}_production` },
    });
  });

  afterEach(() => {
    env.MURAL_PAY_SANDBOX_WEBHOOK_PUBLIC_KEY = undefined;
  });

  /**
   * The webhook validation context takes plain string bindings; the shared
   * test env carries the pooled database client alongside them. Read fresh at
   * each call so the sandbox public key set in beforeEach is included.
   */
  function verificationEnv(): Record<string, string | undefined> {
    const { db: _db, ...bindings } = env;
    return bindings;
  }

  async function seedCounterparty(providerData: Record<string, unknown>): Promise<void> {
    await getDb(env).batch([
      getDb(env)
        .prepare(
          `INSERT INTO counterparties (
             id, organization_id, project_id, entity_type, display_name,
             status, created_by, mural_organization_id, provider_data
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb)`
        )
        .bind(
          counterpartyId,
          organizationId,
          projectId,
          "business",
          "Mural Audit Regression Buyer",
          "active",
          userId,
          muralOrganizationId,
          providerData
        ),
      getDb(env)
        .prepare(
          `INSERT INTO kyc_wallets (
             id, organization_id, project_id, wallet_address, network,
             counterparty_id, kyc_status, created_by
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          kycWalletId,
          organizationId,
          projectId,
          "11111111111111111111111111111111",
          "solana",
          counterpartyId,
          "pending",
          userId
        ),
    ]);
  }

  async function signAndApply(
    eventBody: Record<string, unknown>
  ): Promise<{ applied: boolean; deliveryId: string }> {
    const body = JSON.stringify(eventBody);
    const timestamp = new Date().toISOString();
    const signature = createSign("SHA256")
      .update(`${timestamp}.${body}`)
      .sign(privateKey)
      .toString("base64");
    const processor = new MuralWebhookProcessor();
    const headers = new Headers({
      "x-mural-webhook-signature": signature,
      "x-mural-webhook-timestamp": timestamp,
    });
    // Negative control: a body that does not match the signature is rejected,
    // so everything below was admitted by a verified delivery.
    await expect(
      processor.verify({
        env: verificationEnv(),
        environment: "sandbox",
        headers,
        rawBody: `${body} `,
        requestUrl: "http://localhost/webhooks/payments/ramps/sandbox/mural",
      })
    ).rejects.toThrow();
    const verified = await processor.verify({
      env: verificationEnv(),
      environment: "sandbox",
      headers,
      rawBody: body,
      requestUrl: "http://localhost/webhooks/payments/ramps/sandbox/mural",
    });
    const deliveryId = (verified as Record<string, string>).__sdpDeliveryId;
    const events = createPostgresRampWebhookEventsRepository(getDb(env));
    const stored = await events.insertEvent({
      provider: "mural",
      environment: "sandbox",
      payload: verified,
    });
    return {
      applied: await applyStoredRampWebhookEvent(env, stored, stored.attempts + 1),
      deliveryId,
    };
  }

  it("admits a signed KYC approval to the append-only audit ledger", async () => {
    await seedCounterparty({
      mural: { organization: { id: muralOrganizationId, kycStatus: "pending" } },
    });

    const { applied, deliveryId } = await signAndApply({
      id: "mural_event_regression_kyc_approved",
      payload: {
        type: "verification_status_changed",
        organizationId: muralOrganizationId,
        currentStatus: { type: "approved", approvedAt: "2026-09-25T00:00:00.000Z" },
      },
    });
    expect(applied).toBe(true);

    const counterparty = await getDb(env)
      .prepare("SELECT provider_data FROM counterparties WHERE id = ?")
      .bind(counterpartyId)
      .first<{ provider_data: { mural?: { organization?: { kycStatus?: string } } } }>();
    const wallet = await getDb(env)
      .prepare("SELECT kyc_status FROM kyc_wallets WHERE id = ?")
      .bind(kycWalletId)
      .first<{ kyc_status: string }>();
    expect(counterparty?.provider_data.mural?.organization?.kycStatus).toBe("approved");
    expect(wallet?.kyc_status).toBe("verified");

    // The durable inbox row is deleted on success; the audit-ledger admission
    // is what survives it.
    const inbox = await getDb(env)
      .prepare("SELECT count(*)::int AS count FROM ramp_webhook_events")
      .first<{ count: number }>();
    expect(inbox?.count).toBe(0);

    const auditRows = await readAuditRows(organizationId);
    const intents = auditRows.filter(
      (row) =>
        row.action === "maintenance" &&
        row.resource_type === "audit_ledger" &&
        parseMetadata(row).auditPhase === "intent"
    );
    // The outcome carries the admitted operation's action, not the
    // maintenance wrapper; it links back to the intent via auditIntentId.
    const outcomes = auditRows.filter(
      (row) =>
        row.action === "update" &&
        row.resource_type === "counterparty" &&
        parseMetadata(row).auditPhase === "outcome"
    );
    expect(intents).toHaveLength(1);
    expect(outcomes).toHaveLength(1);
    expect(sole(outcomes).resource_id).toBe(counterpartyId);

    const intentMetadata = parseMetadata(sole(intents)) as {
      target?: { metadata?: Record<string, unknown> };
    };
    const admitted = intentMetadata.target?.metadata ?? {};
    expect(admitted).toMatchObject({
      provider: "mural",
      trigger: "mural_webhook",
      eventKind: "kyc_status",
      providerEventId: deliveryId,
      muralOrganizationId,
      projectId,
      counterpartyId,
      statusScope: "kyc",
      oldStatus: "pending",
      newStatus: "approved",
      walletScope: "counterparty_kyc_wallets",
    });
    expect(sole(intents).request_id).toBe(deliveryId);

    // Outcomes link back to their durable intent.
    const outcomeMetadata = parseMetadata(sole(outcomes)) as {
      auditIntentId?: string;
      target?: { metadata?: Record<string, unknown> };
    };
    expect(outcomeMetadata.auditIntentId).toBe(sole(intents).resource_id);
    expect(sole(outcomes).status).toBe("success");

    // Every sealed ledger entry carries its append-only anchor.
    const anchors = await getDb(env)
      .prepare("SELECT count(*)::int AS count FROM audit_ledger_anchors")
      .first<{ count: number }>();
    expect(anchors?.count).toBe(auditRows.length);
    expect(anchors?.count ?? 0).toBeGreaterThan(0);
  });

  it("admits a signed TOS acceptance to the append-only audit ledger", async () => {
    await seedCounterparty({
      mural: { organization: { id: muralOrganizationId, kycStatus: "pending" } },
    });

    const { applied, deliveryId } = await signAndApply({
      id: "mural_event_regression_tos_accepted",
      payload: { type: "tos_accepted", organizationId: muralOrganizationId },
    });
    expect(applied).toBe(true);

    const counterparty = await getDb(env)
      .prepare("SELECT provider_data FROM counterparties WHERE id = ?")
      .bind(counterpartyId)
      .first<{ provider_data: { mural?: { organization?: { tosStatus?: string } } } }>();
    expect(counterparty?.provider_data.mural?.organization?.tosStatus).toBe("ACCEPTED");

    const auditRows = await readAuditRows(organizationId);
    const intents = auditRows.filter((row) => parseMetadata(row).auditPhase === "intent");
    expect(intents).toHaveLength(1);
    const intentMetadata = parseMetadata(sole(intents)) as {
      target?: { metadata?: Record<string, unknown> };
    };
    expect(intentMetadata.target?.metadata).toMatchObject({
      eventKind: "tos_accepted",
      providerEventId: deliveryId,
      statusScope: "tos",
      oldStatus: null,
      newStatus: "ACCEPTED",
    });

    const anchors = await getDb(env)
      .prepare("SELECT count(*)::int AS count FROM audit_ledger_anchors")
      .first<{ count: number }>();
    expect(anchors?.count).toBe(auditRows.length);
    expect(anchors?.count ?? 0).toBeGreaterThan(0);
  });

  it("aborts the mutable write when audit admission fails", async () => {
    await seedCounterparty({
      mural: { organization: { id: muralOrganizationId, kycStatus: "pending" } },
    });

    const body = JSON.stringify({
      id: "mural_event_regression_admission_fails",
      payload: {
        type: "verification_status_changed",
        organizationId: muralOrganizationId,
        currentStatus: { type: "approved", approvedAt: "2026-09-25T00:00:00.000Z" },
      },
    });
    const timestamp = new Date().toISOString();
    const signature = createSign("SHA256")
      .update(`${timestamp}.${body}`)
      .sign(privateKey)
      .toString("base64");
    const processor = new MuralWebhookProcessor();
    const verified = await processor.verify({
      env: verificationEnv(),
      environment: "sandbox",
      headers: new Headers({
        "x-mural-webhook-signature": signature,
        "x-mural-webhook-timestamp": timestamp,
      }),
      rawBody: body,
      requestUrl: "http://localhost/webhooks/payments/ramps/sandbox/mural",
    });
    const events = createPostgresRampWebhookEventsRepository(getDb(env));
    const stored = await events.insertEvent({
      provider: "mural",
      environment: "sandbox",
      payload: verified,
    });

    // An unreachable checkpoint store refuses the durable intent; the
    // fail-closed contract aborts the mutation and leaves the inbox row
    // pending so the delivery is retried instead of silently lost.
    const unreachableRedis = {
      ...env,
      REDIS_URL: "redis://127.0.0.1:1",
    } as typeof env;
    await expect(
      applyStoredRampWebhookEvent(unreachableRedis, stored, stored.attempts + 1)
    ).resolves.toBe(false);

    const counterparty = await getDb(env)
      .prepare("SELECT provider_data FROM counterparties WHERE id = ?")
      .bind(counterpartyId)
      .first<{ provider_data: { mural?: { organization?: { kycStatus?: string } } } }>();
    const wallet = await getDb(env)
      .prepare("SELECT kyc_status FROM kyc_wallets WHERE id = ?")
      .bind(kycWalletId)
      .first<{ kyc_status: string }>();
    expect(counterparty?.provider_data.mural?.organization?.kycStatus).toBe("pending");
    expect(wallet?.kyc_status).toBe("pending");

    const inbox = await getDb(env)
      .prepare("SELECT count(*)::int AS count FROM ramp_webhook_events")
      .first<{ count: number }>();
    expect(inbox?.count).toBe(1);
  });

  it("ignores a stale replayed status without a new mutation or admission", async () => {
    await seedCounterparty({
      mural: { organization: { id: muralOrganizationId, kycStatus: "approved" } },
    });

    const { applied } = await signAndApply({
      id: "mural_event_regression_stale_pending",
      payload: {
        type: "verification_status_changed",
        organizationId: muralOrganizationId,
        currentStatus: { type: "pending", approvedAt: null },
      },
    });
    expect(applied).toBe(true);

    const counterparty = await getDb(env)
      .prepare("SELECT provider_data FROM counterparties WHERE id = ?")
      .bind(counterpartyId)
      .first<{ provider_data: { mural?: { organization?: { kycStatus?: string } } } }>();
    expect(counterparty?.provider_data.mural?.organization?.kycStatus).toBe("approved");

    const wallet = await getDb(env)
      .prepare("SELECT kyc_status FROM kyc_wallets WHERE id = ?")
      .bind(kycWalletId)
      .first<{ kyc_status: string }>();
    expect(wallet?.kyc_status).toBe("pending");

    // No mutation, no admission: the stale event is only acknowledged.
    const auditRows = await readAuditRows(organizationId);
    expect(auditRows).toHaveLength(0);
  });
});
