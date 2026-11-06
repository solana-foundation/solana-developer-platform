import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { createPostgresRampWebhookEventsRepository } from "@/db/repositories/ramp-webhook-event.repository";
import { applyStoredRampWebhookEvent } from "@/services/jobs/replay-ramp-webhook-events";
import { env } from "@/test/helpers/env";
import { installHercleTestEnv } from "@/test/helpers/hercle-env";
import { hercleSecondsAgo, seedHercleLink } from "@/test/helpers/hercle-links";
import {
  deliverHercleWebhook,
  hercleVerificationBody,
  hercleWebhookKeyPair,
} from "@/test/helpers/hercle-webhooks";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";

/**
 * Evidence for `docs/contributing/ramp-provider-safety.md` with Hercle's `customer.verification.status_changed` deliveries.
 * Each event is signed with a generated P-256 key and goes through the public webhook route and the inbox.
 * The event names the business by its Hercle account id, which decides the tenant, and its envelope `timestamp` orders it.
 */
describe("Hercle verification webhooks", () => {
  const USER_ID = "usr_hercle_verification";
  const BUSINESS = {
    organizationId: "org_hercle_verification",
    projectId: "prj_hercle_verification",
    counterpartyId: "cpty_hercle_verification",
    accountId: "acct_hercle_verification",
  };
  const PRODUCTION_BUSINESS = {
    organizationId: BUSINESS.organizationId,
    projectId: `${BUSINESS.projectId}_production`,
    counterpartyId: "cpty_hercle_verification_production",
    accountId: "acct_hercle_verification_production",
  };
  const OTHER_TENANT = {
    organizationId: "org_hercle_verification_other",
    projectId: "prj_hercle_verification_other",
    counterpartyId: "cpty_hercle_verification_other",
    accountId: "acct_hercle_verification_other",
  };

  const WEBHOOK_KEY = hercleWebhookKeyPair();
  installHercleTestEnv({ HERCLE_SANDBOX_WEBHOOK_PUBLIC_KEY: WEBHOOK_KEY.publicKeyPem });

  async function deliver(accountId: string, status: string, timestamp: number) {
    return deliverHercleWebhook(
      hercleVerificationBody(accountId, status, timestamp),
      WEBHOOK_KEY.privateKey,
      { timestamp }
    );
  }

  async function readLink(business: { counterpartyId: string }) {
    return getDb(env)
      .prepare(
        `SELECT provider_status, provider_status_observed_at, updated_at
           FROM counterparty_provider_accounts
          WHERE counterparty_id = ? AND provider = 'hercle' AND kind = 'customer_link'`
      )
      .bind(business.counterpartyId)
      .first<{
        provider_status: string | null;
        provider_status_observed_at: string | null;
        updated_at: string;
      }>();
  }

  async function readInboxRows() {
    const result = await getDb(env)
      .prepare(
        "SELECT status, apply_outcome, last_error FROM ramp_webhook_events WHERE provider = 'hercle' ORDER BY created_at"
      )
      .all<{ status: string; apply_outcome: string | null; last_error: string | null }>();
    return result.results;
  }

  async function seedTenant(organizationId: string, slug: string) {
    await getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(organizationId, slug, slug, "enterprise", "active")
      .run();
  }

  async function seedBusiness(business: typeof BUSINESS, providerStatus: string) {
    await getDb(env)
      .prepare(
        `INSERT INTO counterparties (
           id, organization_id, project_id, entity_type, display_name, status, created_by
         ) VALUES (?, ?, ?, 'business', 'Hercle Verification AG', 'active', ?)`
      )
      .bind(business.counterpartyId, business.organizationId, business.projectId, USER_ID)
      .run();
    await seedHercleLink(business, business.accountId, providerStatus);
  }

  beforeEach(async () => {
    await seedTestDatabase(env);
    await seedTenant(BUSINESS.organizationId, "hercle-verification-org");
    await seedTenant(OTHER_TENANT.organizationId, "hercle-verification-other-org");
    await getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
      .bind(USER_ID, "hercle-verification@example.com", 1, "active")
      .run();
    await seedDefaultProjects(getDb(env), {
      organizationId: BUSINESS.organizationId,
      createdBy: USER_ID,
      members: [],
      ids: { sandbox: BUSINESS.projectId, production: PRODUCTION_BUSINESS.projectId },
    });
    await seedDefaultProjects(getDb(env), {
      organizationId: OTHER_TENANT.organizationId,
      createdBy: USER_ID,
      members: [],
      ids: { sandbox: OTHER_TENANT.projectId, production: `${OTHER_TENANT.projectId}_production` },
    });
    await seedBusiness(BUSINESS, "approved");
    await seedBusiness(PRODUCTION_BUSINESS, "approved");
    await seedBusiness(OTHER_TENANT, "approved");
  });

  it("records each verdict Hercle sends on the link of the account it names, at the event's time", async () => {
    const statuses = ["action_required", "pending", "rejected", "approved"] as const;
    for (const [index, status] of statuses.entries()) {
      const timestamp = hercleSecondsAgo(240 - index * 60);

      const res = await deliver(BUSINESS.accountId, status, timestamp);

      expect(res.status).toBe(200);
      expect(await readLink(BUSINESS)).toMatchObject({
        provider_status: status,
        provider_status_observed_at: new Date(timestamp * 1000 + 999).toISOString(),
      });
    }
    expect(await readInboxRows()).toEqual(
      statuses.map(() => ({ status: "discharged", apply_outcome: "applied", last_error: null }))
    );
    expect((await readLink(OTHER_TENANT))?.provider_status).toBe("approved");
    expect((await readLink(PRODUCTION_BUSINESS))?.provider_status).toBe("approved");
  });

  it("takes a redelivered verdict, which has no delivery id, without changing the link", async () => {
    const timestamp = hercleSecondsAgo(60);
    await deliver(BUSINESS.accountId, "rejected", timestamp);
    const first = await readLink(BUSINESS);

    await deliver(BUSINESS.accountId, "rejected", timestamp);

    expect(await readLink(BUSINESS)).toEqual(first);
    expect(await readInboxRows()).toMatchObject([
      { status: "discharged", apply_outcome: "applied" },
      { status: "discharged", apply_outcome: "ignored" },
    ]);
  });

  it("never lets an older verdict undo a newer one, delivered late or replayed from the inbox", async () => {
    const events = createPostgresRampWebhookEventsRepository(getDb(env));
    // An approval whose background apply never ran, so the inbox replays it after the revocation below.
    const { row: stranded } = await events.insertVerifiedEvent({
      provider: "hercle",
      environment: "sandbox",
      rawBody: hercleVerificationBody(BUSINESS.accountId, "approved", hercleSecondsAgo(180)),
      providerEventId: null,
    });

    await deliver(BUSINESS.accountId, "rejected", hercleSecondsAgo(60));
    await deliver(BUSINESS.accountId, "approved", hercleSecondsAgo(120));
    const replayed = await applyStoredRampWebhookEvent(env, stranded, stranded.attempts + 1);

    expect(replayed).toBe(false);
    expect((await readLink(BUSINESS))?.provider_status).toBe("rejected");
    expect(await readInboxRows()).toMatchObject([
      { status: "discharged", apply_outcome: "ignored" },
      { status: "discharged", apply_outcome: "applied" },
      { status: "discharged", apply_outcome: "ignored" },
    ]);
  });

  it("lets a verdict that holds quotes back win a same-second tie, and never an approval", async () => {
    const timestamp = hercleSecondsAgo(30);
    await deliver(BUSINESS.accountId, "approved", timestamp);

    await deliver(BUSINESS.accountId, "pending", timestamp);
    expect((await readLink(BUSINESS))?.provider_status).toBe("pending");

    await deliver(BUSINESS.accountId, "approved", timestamp);
    expect((await readLink(BUSINESS))?.provider_status).toBe("pending");
  });

  it("never lifts a suspension on a verdict, which cannot show one", async () => {
    await getDb(env)
      .prepare(
        "UPDATE counterparty_provider_accounts SET provider_status = 'suspended' WHERE counterparty_id = ?"
      )
      .bind(BUSINESS.counterpartyId)
      .run();

    await deliver(BUSINESS.accountId, "approved", hercleSecondsAgo(10));

    expect((await readLink(BUSINESS))?.provider_status).toBe("suspended");
    expect(await readInboxRows()).toMatchObject([
      { status: "discharged", apply_outcome: "ignored" },
    ]);
  });

  it("discards a sandbox delivery naming a production business, and leaves its link alone", async () => {
    await deliver(PRODUCTION_BUSINESS.accountId, "rejected", hercleSecondsAgo(10));

    expect((await readLink(PRODUCTION_BUSINESS))?.provider_status).toBe("approved");
    expect(await readInboxRows()).toMatchObject([
      { status: "discharged", apply_outcome: "discarded", last_error: "environment_mismatch" },
    ]);
  });

  it("parks a production delivery naming a sandbox business for review", async () => {
    const events = createPostgresRampWebhookEventsRepository(getDb(env));
    const { row } = await events.insertVerifiedEvent({
      provider: "hercle",
      environment: "production",
      rawBody: hercleVerificationBody(BUSINESS.accountId, "rejected", hercleSecondsAgo(10)),
      providerEventId: null,
    });

    expect(await applyStoredRampWebhookEvent(env, row, 1)).toBe(false);

    expect((await readLink(BUSINESS))?.provider_status).toBe("approved");
    expect(await readInboxRows()).toMatchObject([
      { status: "failed", apply_outcome: "refused", last_error: "environment_mismatch" },
    ]);
  });

  it("ignores a verdict for an account SDP holds no active link for", async () => {
    await getDb(env)
      .prepare(
        "UPDATE counterparty_provider_accounts SET status = 'archived' WHERE counterparty_id = ?"
      )
      .bind(BUSINESS.counterpartyId)
      .run();

    await deliver("acct_hercle_verification_unknown", "rejected", hercleSecondsAgo(10));
    await deliver(BUSINESS.accountId, "rejected", hercleSecondsAgo(10));

    expect((await readLink(BUSINESS))?.provider_status).toBe("approved");
    expect((await readLink(OTHER_TENANT))?.provider_status).toBe("approved");
    expect(await readInboxRows()).toMatchObject([
      { status: "discharged", apply_outcome: "ignored" },
      { status: "discharged", apply_outcome: "ignored" },
    ]);
  });

  it("ignores a verdict SDP does not know instead of guessing", async () => {
    await deliver(BUSINESS.accountId, "on_hold", hercleSecondsAgo(10));

    expect((await readLink(BUSINESS))?.provider_status).toBe("approved");
    expect(await readInboxRows()).toMatchObject([
      { status: "discharged", apply_outcome: "ignored" },
    ]);
  });

  it("rejects a delivery signed with another key and leaves the link alone", async () => {
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    const timestamp = hercleSecondsAgo(0);

    const res = await deliverHercleWebhook(
      hercleVerificationBody(BUSINESS.accountId, "rejected", timestamp),
      other,
      { timestamp }
    );

    expect(res.status).toBe(401);
    expect(await readInboxRows()).toHaveLength(0);
    expect((await readLink(BUSINESS))?.provider_status).toBe("approved");
  });
});
