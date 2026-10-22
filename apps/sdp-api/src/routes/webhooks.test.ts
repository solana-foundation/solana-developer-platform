import { createHmac } from "node:crypto";
import { hashString } from "@sdp/payments/hash";
import type { PaymentTransferStatus } from "@sdp/types/payments";
import { wellKnownMint } from "@sdp/types/well-known-tokens";
import type { ExecutionContext } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import { app } from "@/index";
import { ALL_API_KEY_GRANTS } from "@/test/fixtures/api-keys";
import { signSeededClerkMember } from "@/test/helpers/clerk-member";
import { env } from "@/test/helpers/env";
import { readInvitationStatus, seedInvitation } from "@/test/helpers/invitations";
import { organizationMember, seedOrganizationMembers } from "@/test/helpers/organization-members";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { required } from "@/test/helpers/required";
import { seedApiKeyRow, seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";

const WEBHOOK_SECRET = `whsec_${Buffer.from("test_clerk_webhook_secret_1234567890").toString("base64")}`;

async function simulateClerkWebhook(event: { type: string; data: Record<string, unknown> }) {
  const payload = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const messageId = `msg_${crypto.randomUUID()}`;
  const key = Buffer.from(WEBHOOK_SECRET.slice("whsec_".length), "base64");
  const digest = createHmac("sha256", key)
    .update(`${messageId}.${timestamp}.${payload}`)
    .digest("base64");
  const signature = `v1,${digest}`;
  return app.request(
    "/webhooks/clerk/link-orgs",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "svix-id": messageId,
        "svix-timestamp": String(timestamp),
        "svix-signature": signature,
      },
      body: payload,
    },
    env
  );
}

const KNOWN_ORGANIZATION = { id: "org_webhook_known", slug: "webhook-known" };
const KNOWN_CLERK_ORG_ID = `clerk_org_${KNOWN_ORGANIZATION.id}`;
const KNOWN_ADMIN = organizationMember("webhook_known_admin", "admin");
const OUTSIDER = organizationMember("webhook_outsider", "member");

async function seedKnownOrganization(): Promise<void> {
  const db = getDb(env);
  await seedOrganizationMembers(db, { organization: KNOWN_ORGANIZATION, members: [KNOWN_ADMIN] });
  await seedOrganizationMembers(db, {
    organization: { id: "org_webhook_outsider", slug: "webhook-outsider" },
    members: [OUTSIDER],
  });
  await signSeededClerkMember(env, db, KNOWN_ADMIN.userId, KNOWN_ORGANIZATION.id);
  await signSeededClerkMember(env, db, OUTSIDER.userId, "org_webhook_outsider");
}

function knownOrganizationMemberships() {
  return getDb(env).queryMany(
    "SELECT user_id, role, status FROM organization_members WHERE organization_id = ? ORDER BY user_id",
    [KNOWN_ORGANIZATION.id]
  );
}

describe("Clerk webhooks", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    env.CLERK_WEBHOOK_SECRET = WEBHOOK_SECRET;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    env.CLERK_WEBHOOK_SECRET = undefined;
    await clearKVStores(env);
  });
  it.each(["organization.created", "organization.updated"])(
    "%s syncs a known organization's name and creates nothing for one SDP never created",
    async (type) => {
      await seedKnownOrganization();

      const known = await simulateClerkWebhook({
        type,
        data: { id: KNOWN_CLERK_ORG_ID, name: "Renamed Org", slug: "renamed-org" },
      });
      const unknown = await simulateClerkWebhook({
        type,
        data: { id: "org_clerk_webhook_unknown", name: "Stranger Org", slug: "stranger-org" },
      });

      expect([known.status, unknown.status]).toEqual([200, 200]);
      expect(
        await getDb(env).queryOne("SELECT name, slug FROM organizations WHERE id = ?", [
          KNOWN_ORGANIZATION.id,
        ])
      ).toEqual({ name: "Renamed Org", slug: "renamed-org" });
      expect(
        await getDb(env).queryMany(
          "SELECT id FROM auth_organization_identities WHERE provider_org_id = ? UNION ALL SELECT id FROM organizations WHERE slug = ?",
          ["org_clerk_webhook_unknown", "stranger-org"]
        )
      ).toEqual([]);
    }
  );
  it.each([
    "organizationMembership.created",
    "organizationMembership.updated",
    "organizationMembership.deleted",
  ])("%s writes no membership", async (type) => {
    await seedKnownOrganization();
    const before = await knownOrganizationMemberships();

    for (const [clerkUserId, role] of [
      [`clerk_user_${KNOWN_ADMIN.userId}`, "org:member"],
      [`clerk_user_${OUTSIDER.userId}`, "org:admin"],
    ]) {
      const response = await simulateClerkWebhook({
        type,
        data: {
          id: `orgmem_${clerkUserId}`,
          organization: { id: KNOWN_CLERK_ORG_ID, name: KNOWN_ORGANIZATION.slug },
          role,
          public_user_data: { user_id: clerkUserId },
        },
      });
      expect(response.status).toBe(200);
    }

    expect(before).toEqual([{ user_id: KNOWN_ADMIN.userId, role: "admin", status: "active" }]);
    expect(await knownOrganizationMemberships()).toEqual(before);
  });
  it("leaves the user and their memberships untouched when Clerk deletes the user", async () => {
    await seedKnownOrganization();

    const response = await simulateClerkWebhook({
      type: "user.deleted",
      data: { id: `clerk_user_${KNOWN_ADMIN.userId}`, object: "user", deleted: true },
    });

    expect(response.status).toBe(200);
    expect(
      await getDb(env).queryOne("SELECT status FROM users WHERE id = ?", [KNOWN_ADMIN.userId])
    ).toEqual({ status: "active" });
    expect(await knownOrganizationMemberships()).toEqual([
      { user_id: KNOWN_ADMIN.userId, role: "admin", status: "active" },
    ]);
  });
  it("refuses the organization's API keys once Clerk deletes it", async () => {
    const clerkOrgId = "org_clerk_webhook_cache_invalidation";
    const orgId = "org_webhook_cache_invalidation";
    const projectId = "prj_webhook_cache_invalidation";
    const userId = "usr_webhook_cache_invalidation";
    const rawKey = ["sk", "test", "webhook", "cache", "invalidation"].join("_");
    const keyId = "key_webhook_cache_invalidation";
    const keyHash = await hashString(rawKey, env.API_KEY_PEPPER);
    const db = getDb(env);
    await db.batch([
      db
        .prepare(
          "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, 'Cache Invalidation Org', ?, 'individual', 'active')"
        )
        .bind(orgId, orgId),
      db
        .prepare(`INSERT INTO auth_organization_identities (id, provider, provider_org_id, organization_id, slug)
           VALUES (?, 'clerk', ?, ?, ?)`)
        .bind(`aoi_${orgId}`, clerkOrgId, orgId, orgId),
      db
        .prepare(
          "INSERT INTO users (id, email, email_verified, status) VALUES (?, 'webhook-cache@example.com', 1, 'active')"
        )
        .bind(userId),
    ]);
    await seedDefaultProjects(db, {
      organizationId: orgId,
      createdBy: userId,
      members: [],
      ids: { sandbox: projectId, production: `${projectId}_production` },
    });
    await db.batch([
      db
        .prepare(`INSERT INTO api_keys
             (id, organization_id, project_id, created_by, name, key_prefix, key_hash, grants, status)
           VALUES (?, ?, ?, ?, 'Webhook cache key', 'sk_test_web', ?, ?, 'active')`)
        .bind(keyId, orgId, projectId, userId, keyHash, ALL_API_KEY_GRANTS),
    ]);
    await seedApiKeyRow(env, keyHash, {
      id: keyId,
      organizationId: orgId,
      projectId,
      grants: ALL_API_KEY_GRANTS,
      environment: "sandbox",
      rateLimitTier: "standard",
      allowedIps: null,
      status: "active",
      expiresAt: null,
      rotationDeadline: null,
    });
    const authedRequest = () =>
      app.request(
        `/v1/organizations/${orgId}`,
        { headers: { Authorization: `Bearer ${rawKey}` } },
        env
      );
    expect((await authedRequest()).status).toBe(200);
    const res = await simulateClerkWebhook({
      type: "organization.deleted",
      data: { id: clerkOrgId, object: "organization", deleted: true },
    });
    expect(res.status).toBe(200);
    expect((await authedRequest()).status).toBe(401);
  });
  it("keeps Clerk identity email aligned with the local user when a new email is taken", async () => {
    await getDb(env).batch([
      getDb(env)
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
        .bind("usr_clerk_existing", "old@example.com"),
      getDb(env)
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
        .bind("usr_email_owner", "taken@example.com"),
      getDb(env)
        .prepare(`INSERT INTO auth_user_identities (id, provider, provider_user_id, user_id, email)
           VALUES (?, 'clerk', ?, ?, ?)`)
        .bind("aui_existing", "user_clerk_existing", "usr_clerk_existing", "old@example.com"),
    ]);
    const updated = await simulateClerkWebhook({
      type: "user.updated",
      data: {
        id: "user_clerk_existing",
        primary_email_address_id: "email_taken",
        email_addresses: [
          {
            id: "email_taken",
            email_address: "taken@example.com",
            verification: { status: "verified" },
          },
        ],
      },
    });
    expect(updated.status).toBe(200);
    const identity = await getDb(env)
      .prepare(`SELECT u.email AS user_email, aui.email AS identity_email
         FROM auth_user_identities aui
         JOIN users u ON u.id = aui.user_id
         WHERE aui.provider = 'clerk' AND aui.provider_user_id = ?`)
      .bind("user_clerk_existing")
      .first<{
        user_email: string;
        identity_email: string;
      }>();
    expect(identity).toEqual({
      user_email: "old@example.com",
      identity_email: "old@example.com",
    });
  });
  it("does not link an unverified Clerk email to an existing local user", async () => {
    await getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind("usr_verified_email_owner", "victim@example.com")
      .run();
    const created = await simulateClerkWebhook({
      type: "user.created",
      data: {
        id: "user_unverified_collision",
        primary_email_address_id: "email_unverified_collision",
        email_addresses: [
          {
            id: "email_unverified_collision",
            email_address: "victim@example.com",
            verification: { status: "unverified" },
          },
        ],
      },
    });
    expect(created.status).toBe(200);
    const identity = await getDb(env)
      .prepare(`SELECT user_id
         FROM auth_user_identities
         WHERE provider = 'clerk' AND provider_user_id = ?`)
      .bind("user_unverified_collision")
      .first<{
        user_id: string;
      }>();
    expect(identity).toBeNull();
    const verified = await simulateClerkWebhook({
      type: "user.updated",
      data: {
        id: "user_unverified_collision",
        primary_email_address_id: "email_unverified_collision",
        email_addresses: [
          {
            id: "email_unverified_collision",
            email_address: "victim@example.com",
            verification: { status: "verified" },
          },
        ],
      },
    });
    expect(verified.status).toBe(200);
    const verifiedIdentity = await getDb(env)
      .prepare(`SELECT user_id
         FROM auth_user_identities
         WHERE provider = 'clerk' AND provider_user_id = ?`)
      .bind("user_unverified_collision")
      .first<{
        user_id: string;
      }>();
    expect(required(verifiedIdentity).user_id).toBe("usr_verified_email_owner");
  });
  it("revokes pending invitations and ends memberships when Clerk deletes a known organization", async () => {
    await seedKnownOrganization();
    await seedInvitation(getDb(env), {
      id: "inv_webhook_known_pending",
      organizationId: KNOWN_ORGANIZATION.id,
      email: "pending@example.com",
      role: "member",
      invitedBy: KNOWN_ADMIN.userId,
      status: "pending",
      expiresInDays: 7,
    });

    const response = await simulateClerkWebhook({
      type: "organization.deleted",
      data: { id: KNOWN_CLERK_ORG_ID, object: "organization", deleted: true },
    });

    expect(response.status).toBe(200);
    expect(await readInvitationStatus(getDb(env), "inv_webhook_known_pending")).toBe("revoked");
    expect(
      await getDb(env).queryOne("SELECT status FROM organizations WHERE id = ?", [
        KNOWN_ORGANIZATION.id,
      ])
    ).toEqual({ status: "deleted" });
    expect(await knownOrganizationMemberships()).toEqual([
      { user_id: KNOWN_ADMIN.userId, role: "admin", status: "removed" },
    ]);
  });
});

describe("MoonPay ramp webhook", () => {
  const ORG_ID = "org_moonpay_webhook";
  const PROJECT_ID = "prj_moonpay_webhook";
  const USER_ID = "usr_moonpay_webhook";
  const TRANSFER_ID = "xfr_moonpay_webhook";
  const MOONPAY_TRANSACTION_ID = "0a5bb889-9afb-4b8d-835b-9b9855d67509";
  const MOONPAY_WEBHOOK_KEY = "wk_test_moonpay_webhook";
  const COUNTERPARTY_ID = "cpty_moonpay_webhook";
  const MOONPAY_CUSTOMER_ID = "6e9fd8db-98e4-46f4-bd6e-6a3c30fdda19";
  const SOL_MINT = required(wellKnownMint("SOL", "devnet"));
  function moonpaySignatureHeader(
    body: string,
    timestampSeconds: number,
    options: {
      key: string;
    }
  ) {
    const { key } = options;
    const s = createHmac("sha256", key).update(`${timestampSeconds}.${body}`).digest("hex");
    return `t=${timestampSeconds},s=${s}`;
  }
  async function sendMoonpayWebhook(payload: unknown) {
    const body = JSON.stringify(payload);
    const header = moonpaySignatureHeader(body, Math.floor(Date.now() / 1000), {
      key: MOONPAY_WEBHOOK_KEY,
    });
    const background: Promise<unknown>[] = [];
    const executionCtx: ExecutionContext = {
      waitUntil(promise) {
        background.push(promise);
      },
      passThroughOnException() {},
      props: {},
    };
    const res = await app.request(
      "/webhooks/payments/ramps/sandbox/moonpay",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Moonpay-Signature-V2": header },
        body,
      },
      env,
      executionCtx
    );
    await Promise.allSettled(background);
    return res;
  }
  async function seedMoonpayOnrampTransfer() {
    await getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(ORG_ID, "MoonPay Webhook Org", "moonpay-webhook-org", "enterprise", "active")
      .run();
    await getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
      .bind(USER_ID, "moonpay-webhook-user@example.com", 1, "active")
      .run();
    await seedDefaultProjects(getDb(env), {
      organizationId: ORG_ID,
      createdBy: USER_ID,
      members: [],
      ids: { sandbox: PROJECT_ID, production: `${PROJECT_ID}_production` },
    });
    await getDb(env)
      .prepare(`INSERT INTO counterparties (
           id, organization_id, project_id, entity_type, display_name, status, created_by
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(COUNTERPARTY_ID, ORG_ID, PROJECT_ID, "individual", "MoonPay Buyer", "active", USER_ID)
      .run();
    await getDb(env)
      .prepare(`INSERT INTO payment_transfers (
           id, organization_id, project_id, wallet_id, counterparty_id, source_address,
           destination_address, token, amount, memo, type, direction, status, provider,
           provider_reference, delivery_mode, fiat_currency, fiat_amount, provider_data,
           signature, serialized_tx, initiated_by_key_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        TRANSFER_ID,
        ORG_ID,
        PROJECT_ID,
        "wallet_moonpay_webhook",
        COUNTERPARTY_ID,
        null,
        "DestinationSolanaWallet111111111111111111111111",
        SOL_MINT,
        null,
        null,
        "onramp",
        "inbound",
        "awaiting_payment",
        "moonpay",
        null,
        null,
        "USD",
        "47.73",
        {},
        null,
        null,
        null,
        "2026-06-18T00:00:00.000Z",
        "2026-06-18T00:00:00.000Z"
      )
      .run();
  }
  beforeEach(async () => {
    await seedTestDatabase(env);
    env.MOONPAY_SANDBOX_WEBHOOK_SECRET = MOONPAY_WEBHOOK_KEY;
    await seedMoonpayOnrampTransfer();
  });
  afterEach(async () => {
    env.MOONPAY_SANDBOX_WEBHOOK_SECRET = undefined;
  });
  const completedPayload = {
    type: "transaction_updated",
    externalCustomerId: "MOONPAY-ONRAMP-0001",
    data: {
      id: MOONPAY_TRANSACTION_ID,
      status: "completed",
      updatedAt: "2026-06-18T11:00:00.000Z",
      customerId: MOONPAY_CUSTOMER_ID,
      externalTransactionId: TRANSFER_ID,
      failureReason: null,
      baseCurrencyAmount: 47.73,
      quoteCurrencyAmount: 0.649,
      feeAmount: 2,
      extraFeeAmount: 0,
      networkFeeAmount: 0.27,
      areFeesIncluded: true,
      usdRate: 1,
      walletAddress: "WebhookDestinationSolanaWallet111111111111111111",
      cryptoTransactionId: "t11paHKpm79qTHVgSQ4rr9PAqE7ZT87MWpi1f5Nim8XzPyc7aPux",
      baseCurrency: { code: "usd" },
      currency: { code: "sol" },
    },
  };
  it("records provider economics without replacing quoted terms or claiming completion", async () => {
    const res = await sendMoonpayWebhook(completedPayload);
    expect(res.status).toBe(200);
    const transfer = await getDb(env)
      .prepare(`SELECT status, amount, destination_address, signature, provider_reference, provider_data
         FROM payment_transfers WHERE id = ?`)
      .bind(TRANSFER_ID)
      .first<{
        status: string;
        amount: string | null;
        destination_address: string | null;
        signature: string | null;
        provider_reference: string | null;
        provider_data: {
          settlement?: Record<string, unknown>;
        };
      }>();
    expect(required(transfer).status).toBe("settling");
    expect(required(transfer).amount).toBeNull();
    expect(required(transfer).provider_reference).toBe(MOONPAY_TRANSACTION_ID);
    expect(required(transfer).destination_address).toBe(
      "DestinationSolanaWallet111111111111111111111111"
    );
    expect(required(transfer).signature).toBe(
      "t11paHKpm79qTHVgSQ4rr9PAqE7ZT87MWpi1f5Nim8XzPyc7aPux"
    );
    expect(required(transfer).provider_data.settlement).toMatchObject({
      provider: "moonpay",
      status: "completed",
      baseCurrencyCode: "USD",
      baseCurrencyAmount: 47.73,
      quoteCurrencyCode: "SOL",
      quoteCurrencyAmount: 0.649,
      feeAmount: 2,
      networkFeeAmount: 0.27,
    });
  });
  async function readMoonpayTransferStatus(): Promise<PaymentTransferStatus> {
    const row = await getDb(env)
      .prepare("SELECT status FROM payment_transfers WHERE id = ?")
      .bind(TRANSFER_ID)
      .first<{ status: PaymentTransferStatus }>();
    return required(row).status;
  }
  it("refuses a completed transaction that does not name its crypto", async () => {
    const { currency: _currency, ...withoutCrypto } = completedPayload.data;
    const res = await sendMoonpayWebhook({ ...completedPayload, data: withoutCrypto });
    expect(res.status).toBe(200);
    expect(await readMoonpayTransferStatus()).toBe("awaiting_payment");
    const row = await getDb(env)
      .prepare("SELECT status, apply_outcome FROM ramp_webhook_events WHERE provider = 'moonpay'")
      .first<{ status: string; apply_outcome: string }>();
    expect(row).toEqual({ status: "discharged", apply_outcome: "discarded" });
  });
  it("does not complete a transfer when MoonPay delivered another crypto", async () => {
    const res = await sendMoonpayWebhook({
      ...completedPayload,
      data: { ...completedPayload.data, currency: { code: "usdc_sol" } },
    });
    expect(res.status).toBe(200);
    expect(await readMoonpayTransferStatus()).toBe("awaiting_payment");
  });
  it("refuses a completed sale that does not name its crypto", async () => {
    const res = await sendMoonpayWebhook({
      type: "sell_transaction_updated",
      data: {
        id: "cca8ef45-4aac-4a91-851a-02ff991eeef9",
        status: "completed",
        updatedAt: "2026-06-18T11:00:00.000Z",
        externalTransactionId: TRANSFER_ID,
        quoteCurrencyAmount: 16.31,
      },
    });
    expect(res.status).toBe(200);
    expect(await readMoonpayTransferStatus()).toBe("awaiting_payment");
    const row = await getDb(env)
      .prepare("SELECT status, apply_outcome FROM ramp_webhook_events WHERE provider = 'moonpay'")
      .first<{ status: string; apply_outcome: string }>();
    expect(row).toEqual({ status: "discharged", apply_outcome: "discarded" });
  });
  it("does not complete a sale of another crypto", async () => {
    await getDb(env)
      .prepare(`UPDATE payment_transfers SET type = 'offramp', direction = 'outbound' WHERE id = ?`)
      .bind(TRANSFER_ID)
      .run();
    const res = await sendMoonpayWebhook({
      type: "sell_transaction_updated",
      data: {
        id: "cca8ef45-4aac-4a91-851a-02ff991eeef9",
        status: "completed",
        updatedAt: "2026-06-18T11:00:00.000Z",
        customerId: MOONPAY_CUSTOMER_ID,
        externalTransactionId: TRANSFER_ID,
        baseCurrencyAmount: 0.2,
        quoteCurrencyAmount: 16.31,
        baseCurrency: { code: "usdc_sol" },
      },
    });
    expect(res.status).toBe(200);
    expect(await readMoonpayTransferStatus()).toBe("awaiting_payment");
  });
  it("records a completed sell deposit on the correlated SDP transfer", async () => {
    const sourceAddress = "WebhookSourceSolanaWallet111111111111111111111";
    const destinationAddress = "WebhookMoonPayDepositWallet1111111111111111111";
    const providerSignature =
      "4gYf6JwRXvV9LhJqR6CjvhgpqpNrp41cYwHC1PJNBJdk6FHaaBxTkZQHUnwNi1trGf31FyHg6pQJfUmK4D3kVQnG";
    const submittedSignature =
      "TestDepos1tS1gnature11111111111111111111111111111111111111111111111111111111111111111111";
    const moonpayTransactionId = "cca8ef45-4aac-4a91-851a-02ff991eeef9";
    await getDb(env)
      .prepare(`UPDATE payment_transfers
         SET type = 'offramp', direction = 'outbound', source_address = ?,
             destination_address = NULL, amount = '0.2', fiat_amount = NULL, signature = ?
         WHERE id = ?`)
      .bind(sourceAddress, submittedSignature, TRANSFER_ID)
      .run();
    const res = await sendMoonpayWebhook({
      type: "sell_transaction_updated",
      data: {
        id: moonpayTransactionId,
        status: "completed",
        updatedAt: "2026-06-18T11:00:00.000Z",
        customerId: MOONPAY_CUSTOMER_ID,
        externalTransactionId: TRANSFER_ID,
        baseCurrencyAmount: 0.2,
        quoteCurrencyAmount: 16.31,
        refundWalletAddress: sourceAddress,
        depositHash: providerSignature,
        depositWallet: { walletAddress: destinationAddress },
        baseCurrency: { code: "sol" },
      },
    });
    expect(res.status).toBe(200);
    const transfer = await getDb(env)
      .prepare(`SELECT status, amount, fiat_amount, source_address, destination_address,
                signature, provider_reference
         FROM payment_transfers WHERE id = ?`)
      .bind(TRANSFER_ID)
      .first<{
        status: string;
        amount: string | null;
        fiat_amount: string | null;
        source_address: string | null;
        destination_address: string | null;
        signature: string | null;
        provider_reference: string | null;
      }>();
    expect(transfer).toEqual({
      status: "settling",
      amount: "0.2",
      fiat_amount: null,
      source_address: sourceAddress,
      destination_address: null,
      signature: submittedSignature,
      provider_reference: moonpayTransactionId,
    });
  });
  it("links the MoonPay customer to the counterparty and keeps the link stable on redelivery", async () => {
    const first = await sendMoonpayWebhook(completedPayload);
    expect(first.status).toBe(200);
    const link = await getDb(env)
      .prepare(`SELECT id, counterparty_id, provider, provider_customer_reference, status
         FROM counterparty_provider_accounts
         WHERE counterparty_id = ? AND provider = 'moonpay'`)
      .bind(COUNTERPARTY_ID)
      .first<{
        id: string;
        counterparty_id: string;
        provider: string;
        provider_customer_reference: string;
        status: string;
      }>();
    expect(link).toMatchObject({
      counterparty_id: COUNTERPARTY_ID,
      provider: "moonpay",
      provider_customer_reference: MOONPAY_CUSTOMER_ID,
      status: "active",
    });
    const second = await sendMoonpayWebhook(completedPayload);
    expect(second.status).toBe(200);
    const rows = await getDb(env)
      .prepare(`SELECT id FROM counterparty_provider_accounts
         WHERE counterparty_id = ? AND provider = 'moonpay'`)
      .bind(COUNTERPARTY_ID)
      .all<{
        id: string;
      }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0].id).toBe(required(link).id);
  });
  it("keeps an unfunded transfer retryable when a buy attempt fails without economics", async () => {
    const res = await sendMoonpayWebhook({
      type: "transaction_failed",
      externalCustomerId: "MOONPAY-ONRAMP-0001",
      data: {
        id: MOONPAY_TRANSACTION_ID,
        status: "failed",
        updatedAt: "2026-06-18T11:00:00.000Z",
        externalTransactionId: TRANSFER_ID,
        failureReason: "kyc_rejected",
      },
    });
    expect(res.status).toBe(200);
    const transfer = await getDb(env)
      .prepare(
        "SELECT status, error, provider_reference, provider_data FROM payment_transfers WHERE id = ?"
      )
      .bind(TRANSFER_ID)
      .first<{
        status: string;
        error: string | null;
        provider_reference: string | null;
        provider_data: {
          settlement?: unknown;
        };
      }>();
    expect(required(transfer).status).toBe("awaiting_payment");
    expect(required(transfer).error).toBeNull();
    expect(required(transfer).provider_reference).toBeNull();
    expect(required(transfer).provider_data.settlement).toBeUndefined();
    const retired = await getDb(env)
      .prepare("SELECT failure_reason FROM moonpay_failed_transactions WHERE transaction_id = ?")
      .bind(MOONPAY_TRANSACTION_ID)
      .first<{ failure_reason: string | null }>();
    expect(retired).toEqual({ failure_reason: "kyc_rejected" });
  });
  it("rejects a moonpay webhook whose signed timestamp is outside the replay window", async () => {
    const body = JSON.stringify(completedPayload);
    const staleHeader = moonpaySignatureHeader(body, Math.floor(Date.now() / 1000) - 6 * 60, {
      key: MOONPAY_WEBHOOK_KEY,
    });
    const res = await app.request(
      "/webhooks/payments/ramps/sandbox/moonpay",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Moonpay-Signature-V2": staleHeader },
        body,
      },
      env
    );
    expect(res.status).toBe(401);
    const transfer = await getDb(env)
      .prepare("SELECT status FROM payment_transfers WHERE id = ?")
      .bind(TRANSFER_ID)
      .first<{
        status: string;
      }>();
    expect(required(transfer).status).toBe("awaiting_payment");
  });
  it("rejects a moonpay webhook with an invalid signature", async () => {
    const body = JSON.stringify(completedPayload);
    const wrongKeyHeader = moonpaySignatureHeader(body, Math.floor(Date.now() / 1000), {
      key: "wrong_webhook_key",
    });
    const res = await app.request(
      "/webhooks/payments/ramps/sandbox/moonpay",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Moonpay-Signature-V2": wrongKeyHeader },
        body,
      },
      env
    );
    expect(res.status).toBe(401);
  });
  it("refuses an oversized body before verifying its signature", async () => {
    const res = await app.request(
      "/webhooks/payments/ramps/sandbox/moonpay",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Moonpay-Signature-V2": "t=1,s=deadbeef" },
        body: "x".repeat(1024 * 1024 + 1),
      },
      env
    );
    expect(res.status).toBe(413);
  });
});
