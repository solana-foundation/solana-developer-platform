import { createHmac } from "node:crypto";
import { Webhook } from "svix";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { RAMP_PROVIDER_CLIENTS } from "@/lib/ramps";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";

const WEBHOOK_SECRET = `whsec_${Buffer.from("test_clerk_webhook_secret_1234567890").toString(
  "base64"
)}`;

async function sendClerkWebhook(event: { type: string; data: Record<string, unknown> }) {
  const payload = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const messageId = `msg_${crypto.randomUUID()}`;
  const signature = new Webhook(WEBHOOK_SECRET).sign(
    messageId,
    new Date(timestamp * 1000),
    payload
  );

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

describe("Clerk webhooks", () => {
  let originalDeploymentMode: "managed" | "self_hosted" | undefined;

  beforeEach(async () => {
    await seedTestDatabase(env);
    env.CLERK_WEBHOOK_SECRET = WEBHOOK_SECRET;
    // Webhook tier sync is gated by deployment mode — these tests verify the
    // managed-mode behavior (sync runs), so explicitly clear any leaked
    // self-hosted setting from .dev.vars / process env.
    originalDeploymentMode = env.SDP_DEPLOYMENT_MODE;
    env.SDP_DEPLOYMENT_MODE = undefined;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    env.CLERK_WEBHOOK_SECRET = undefined;
    env.CLERK_SECRET_KEY = undefined;
    env.CLERK_API_URL = undefined;
    env.SDP_DEPLOYMENT_MODE = originalDeploymentMode;
    await clearTestDatabase(env);
  });

  it("creates and updates the SDP organization mapping from Clerk organization events", async () => {
    const created = await sendClerkWebhook({
      type: "organization.created",
      data: {
        id: "org_clerk_shared_identity",
        name: "Bookface",
        slug: "bookface",
        private_metadata: {
          sdp: {
            tier: "pro",
            providerOverrides: {
              rpc: {
                helius: true,
              },
            },
          },
        },
      },
    });

    expect(created.status).toBe(200);

    const createdOrg = await getDb(env)
      .prepare(
        `SELECT o.id, o.name, o.slug, o.tier, o.settings, aoi.provider_org_id
         FROM organizations o
         JOIN auth_organization_identities aoi ON aoi.organization_id = o.id
         WHERE aoi.provider = 'clerk' AND aoi.provider_org_id = ?`
      )
      .bind("org_clerk_shared_identity")
      .first<{
        id: string;
        name: string;
        slug: string;
        tier: string;
        settings: string | null;
        provider_org_id: string;
      }>();

    expect(createdOrg).toMatchObject({
      name: "Bookface",
      slug: "bookface",
      tier: "enterprise",
      provider_org_id: "org_clerk_shared_identity",
    });
    expect(createdOrg?.settings ? JSON.parse(createdOrg.settings) : null).toMatchObject({
      providerOverrides: {
        rpc: {
          helius: true,
        },
      },
    });

    const updated = await sendClerkWebhook({
      type: "organization.updated",
      data: {
        id: "org_clerk_shared_identity",
        name: "Bookface Labs",
        slug: "bookface-labs",
        private_metadata: {
          sdp: {
            tier: "individual",
          },
        },
      },
    });

    expect(updated.status).toBe(200);

    const updatedOrg = await getDb(env)
      .prepare(
        `SELECT o.name, o.slug, o.tier, o.settings, aoi.slug AS identity_slug
         FROM organizations o
         JOIN auth_organization_identities aoi ON aoi.organization_id = o.id
         WHERE o.id = ?`
      )
      .bind(createdOrg?.id)
      .first<{
        name: string;
        slug: string;
        tier: string;
        settings: string | null;
        identity_slug: string;
      }>();

    expect(updatedOrg).toMatchObject({
      name: "Bookface Labs",
      slug: "bookface-labs",
      identity_slug: "bookface-labs",
      tier: "individual",
    });
    expect(updatedOrg?.settings ? JSON.parse(updatedOrg.settings) : null).toBeNull();
  });

  it("reuses the resolved Clerk organization when creating from incomplete payloads", async () => {
    env.CLERK_SECRET_KEY = "sk_test_clerk";
    env.CLERK_API_URL = "https://clerk.test/v1";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "org_clerk_incomplete_payload",
          name: "Fetched Bookface",
          slug: "fetched-bookface",
          private_metadata: {
            sdp: {
              tier: "pro",
            },
          },
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        }
      )
    );

    const created = await sendClerkWebhook({
      type: "organization.created",
      data: {
        id: "org_clerk_incomplete_payload",
      },
    });

    expect(created.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://clerk.test/v1/organizations/org_clerk_incomplete_payload",
      expect.any(Object)
    );

    const createdOrg = await getDb(env)
      .prepare(
        `SELECT o.name, o.slug, o.tier, aoi.slug AS identity_slug
         FROM organizations o
         JOIN auth_organization_identities aoi ON aoi.organization_id = o.id
         WHERE aoi.provider = 'clerk' AND aoi.provider_org_id = ?`
      )
      .bind("org_clerk_incomplete_payload")
      .first<{
        name: string;
        slug: string;
        tier: string;
        identity_slug: string;
      }>();

    expect(createdOrg).toEqual({
      name: "Fetched Bookface",
      slug: "fetched-bookface",
      identity_slug: "fetched-bookface",
      tier: "enterprise",
    });
  });

  it("defaults new Clerk organizations to enterprise when SDP tier metadata is missing", async () => {
    const created = await sendClerkWebhook({
      type: "organization.created",
      data: {
        id: "org_clerk_enterprise_default",
        name: "Enterprise By Default",
        slug: "enterprise-by-default",
      },
    });

    expect(created.status).toBe(200);

    const createdOrg = await getDb(env)
      .prepare(
        `SELECT o.name, o.slug, o.tier
         FROM organizations o
         JOIN auth_organization_identities aoi ON aoi.organization_id = o.id
         WHERE aoi.provider = 'clerk' AND aoi.provider_org_id = ?`
      )
      .bind("org_clerk_enterprise_default")
      .first<{
        name: string;
        slug: string;
        tier: string;
      }>();

    expect(createdOrg).toEqual({
      name: "Enterprise By Default",
      slug: "enterprise-by-default",
      tier: "enterprise",
    });
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
        .prepare(
          `INSERT INTO auth_user_identities (id, provider, provider_user_id, user_id, email)
           VALUES (?, 'clerk', ?, ?, ?)`
        )
        .bind("aui_existing", "user_clerk_existing", "usr_clerk_existing", "old@example.com"),
    ]);

    const updated = await sendClerkWebhook({
      type: "user.updated",
      data: {
        id: "user_clerk_existing",
        primary_email_address_id: "email_taken",
        email_addresses: [
          {
            id: "email_taken",
            email_address: "taken@example.com",
          },
        ],
      },
    });

    expect(updated.status).toBe(200);

    const identity = await getDb(env)
      .prepare(
        `SELECT u.email AS user_email, aui.email AS identity_email
         FROM auth_user_identities aui
         JOIN users u ON u.id = aui.user_id
         WHERE aui.provider = 'clerk' AND aui.provider_user_id = ?`
      )
      .bind("user_clerk_existing")
      .first<{ user_email: string; identity_email: string }>();

    expect(identity).toEqual({
      user_email: "old@example.com",
      identity_email: "old@example.com",
    });
  });

  it("syncs organization memberships without creating records on delete-only events", async () => {
    const deleteOnly = await sendClerkWebhook({
      type: "organizationMembership.deleted",
      data: {
        organization: {
          id: "org_clerk_delete_only",
        },
        public_user_data: {
          user_id: "user_delete_only",
        },
      },
    });

    expect(deleteOnly.status).toBe(200);

    const missingOrg = await getDb(env)
      .prepare(
        `SELECT organization_id
         FROM auth_organization_identities
         WHERE provider = 'clerk' AND provider_org_id = ?`
      )
      .bind("org_clerk_delete_only")
      .first<{ organization_id: string }>();

    expect(missingOrg).toBeNull();

    const created = await sendClerkWebhook({
      type: "organizationMembership.created",
      data: {
        organization: {
          id: "org_clerk_membership",
          name: "Membership Org",
          slug: "membership-org",
        },
        role: "org:admin",
        public_user_data: {
          user_id: "user_clerk_member",
          identifier: "Admin@Example.com",
        },
      },
    });

    expect(created.status).toBe(200);

    const membership = await getDb(env)
      .prepare(
        `SELECT u.email, om.role, om.status
         FROM organization_members om
         JOIN users u ON u.id = om.user_id
         JOIN auth_user_identities aui ON aui.user_id = u.id
         WHERE aui.provider = 'clerk' AND aui.provider_user_id = ?`
      )
      .bind("user_clerk_member")
      .first<{ email: string; role: string; status: string }>();

    expect(membership).toEqual({
      email: "admin@example.com",
      role: "admin",
      status: "active",
    });

    const deleted = await sendClerkWebhook({
      type: "organizationMembership.deleted",
      data: {
        organization: {
          id: "org_clerk_membership",
        },
        public_user_data: {
          user_id: "user_clerk_member",
        },
      },
    });

    expect(deleted.status).toBe(200);

    const removed = await getDb(env)
      .prepare(
        `SELECT om.status
         FROM organization_members om
         JOIN auth_user_identities aui ON aui.user_id = om.user_id
         WHERE aui.provider = 'clerk' AND aui.provider_user_id = ?`
      )
      .bind("user_clerk_member")
      .first<{ status: string }>();

    expect(removed?.status).toBe("removed");
  });

  it("syncs user lifecycle and Clerk organization deletion", async () => {
    await sendClerkWebhook({
      type: "organizationMembership.created",
      data: {
        organization: {
          id: "org_clerk_lifecycle",
          name: "Lifecycle Org",
          slug: "lifecycle-org",
        },
        role: "org:member",
        public_user_data: {
          user_id: "user_clerk_lifecycle",
          identifier: "member@example.com",
        },
      },
    });

    const updatedUser = await sendClerkWebhook({
      type: "user.updated",
      data: {
        id: "user_clerk_lifecycle",
        first_name: "Ada",
        last_name: "Lovelace",
        primary_email_address_id: "email_primary",
        email_addresses: [
          {
            id: "email_primary",
            email_address: "ada@example.com",
          },
        ],
      },
    });

    expect(updatedUser.status).toBe(200);

    const user = await getDb(env)
      .prepare(
        `SELECT u.id, u.email, u.name, u.status
         FROM users u
         JOIN auth_user_identities aui ON aui.user_id = u.id
         WHERE aui.provider = 'clerk' AND aui.provider_user_id = ?`
      )
      .bind("user_clerk_lifecycle")
      .first<{ id: string; email: string; name: string | null; status: string }>();

    expect(user).toMatchObject({
      email: "ada@example.com",
      name: "Ada Lovelace",
      status: "active",
    });

    const userId = user?.id;
    expect(userId).toBeTruthy();

    const apiKeyHash = "webhook_lifecycle_key_hash";
    const lifecycleProjectId = "prj_webhook_lifecycle";
    await getDb(env)
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         SELECT ?, aoi.organization_id, ?, ?, ?, ?, ?
         FROM auth_organization_identities aoi
         WHERE aoi.provider = 'clerk' AND aoi.provider_org_id = ?`
      )
      .bind(
        lifecycleProjectId,
        "Lifecycle Project",
        "lifecycle-project",
        "sandbox",
        "active",
        userId,
        "org_clerk_lifecycle"
      )
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO api_keys
         (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, status)
         SELECT ?, aoi.organization_id, ?, ?, ?, ?, ?, ?, ?
         FROM auth_organization_identities aoi
         WHERE aoi.provider = 'clerk' AND aoi.provider_org_id = ?`
      )
      .bind(
        "key_webhook_lifecycle",
        lifecycleProjectId,
        userId,
        "Lifecycle Key",
        "sk_test_web",
        apiKeyHash,
        "api_admin",
        "active",
        "org_clerk_lifecycle"
      )
      .run();

    const deletedUser = await sendClerkWebhook({
      type: "user.deleted",
      data: {
        id: "user_clerk_lifecycle",
      },
    });

    expect(deletedUser.status).toBe(200);

    const removedUser = await getDb(env)
      .prepare("SELECT status FROM users WHERE id = ?")
      .bind(userId)
      .first<{ status: string }>();

    expect(removedUser?.status).toBe("deleted");

    const deletedOrg = await sendClerkWebhook({
      type: "organization.deleted",
      data: {
        id: "org_clerk_lifecycle",
      },
    });

    expect(deletedOrg.status).toBe(200);

    const lifecycleState = await getDb(env)
      .prepare(
        `SELECT o.status AS org_status, om.status AS member_status, ak.status AS api_key_status
         FROM auth_organization_identities aoi
         JOIN organizations o ON o.id = aoi.organization_id
         JOIN organization_members om ON om.organization_id = o.id
         JOIN api_keys ak ON ak.organization_id = o.id
         WHERE aoi.provider = 'clerk' AND aoi.provider_org_id = ?`
      )
      .bind("org_clerk_lifecycle")
      .first<{ org_status: string; member_status: string; api_key_status: string }>();

    expect(lifecycleState).toEqual({
      org_status: "deleted",
      member_status: "removed",
      api_key_status: "revoked",
    });
  });
});

describe("BVNK ramp webhook", () => {
  const BVNK_WEBHOOK_SECRET = "bvnk_webhook_secret_test";
  const ORG_ID = "org_bvnk_webhook";
  const PROJECT_ID = "prj_bvnk_webhook";
  const COUNTERPARTY_ID = "counterparty_bvnk_webhook";
  const CUSTOMER_REFERENCE = "cust_webhook_1";
  const USER_ID = "usr_bvnk_webhook";
  const WALLET_ID = "a:1:wallet:1";

  async function seedVerifiableCounterparty() {
    await getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(ORG_ID, "BVNK Webhook Org", "bvnk-webhook-org", "enterprise", "active")
      .run();
    await getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
      .bind(USER_ID, "webhook-user@example.com", 1, "active")
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(PROJECT_ID, ORG_ID, "Test", "bvnk-webhook-proj", "sandbox", "active", USER_ID)
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO counterparties (
           id, organization_id, project_id, external_id, entity_type, display_name, email,
           identity, provider_data, status, created_by
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`
      )
      .bind(
        COUNTERPARTY_ID,
        ORG_ID,
        PROJECT_ID,
        null,
        "individual",
        "Webhook Buyer",
        "buyer@example.com",
        {},
        {
          bvnk: {
            customer: { customerReference: CUSTOMER_REFERENCE, status: "PENDING" },
            wallets: { "USD:USDC_SOLANA:dest": { walletId: WALLET_ID } },
          },
        },
        null
      )
      .run();
  }

  function sendBvnkWebhook(payload: unknown, signature?: string) {
    const body = JSON.stringify(payload);
    const sig =
      signature ?? createHmac("sha256", BVNK_WEBHOOK_SECRET).update(body).digest("base64");
    return app.request(
      "/webhooks/payments/ramps/sandbox/bvnk",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Signature": sig },
        body,
      },
      env
    );
  }

  beforeEach(async () => {
    await seedTestDatabase(env);
    env.BVNK_SANDBOX_WEBHOOK_SECRET = BVNK_WEBHOOK_SECRET;
    await seedVerifiableCounterparty();
  });

  afterEach(async () => {
    env.BVNK_SANDBOX_WEBHOOK_SECRET = undefined;
    await clearTestDatabase(env);
  });

  async function readBvnk() {
    const row = await getDb(env)
      .prepare("SELECT provider_data FROM counterparties WHERE id = ?")
      .bind(COUNTERPARTY_ID)
      .first<{
        provider_data: {
          bvnk?: {
            customer?: { status?: string; verificationUrl?: string };
            wallets?: Record<
              string,
              { walletId?: string; bankAccount?: { accountNumber?: string; bankName?: string } }
            >;
          };
        };
      }>();
    return row?.provider_data.bvnk;
  }

  it("flips the cached customer status to VERIFIED on a customers:status-change webhook", async () => {
    const res = await sendBvnkWebhook({
      event: "bvnk:customers:status-change",
      data: { customerId: CUSTOMER_REFERENCE, status: "VERIFIED", customerType: "INDIVIDUAL" },
    });

    expect(res.status).toBe(200);
    expect((await readBvnk())?.customer?.status).toBe("VERIFIED");
  });

  it("fetches and caches the verification URL when a status-change reports an unverified status", async () => {
    const getCustomer = vi.spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "getBvnkCustomer").mockResolvedValue({
      reference: CUSTOMER_REFERENCE,
      status: "INFO_REQUIRED",
      verificationUrl: "https://in.sumsub.com/websdk/p/sbx_test",
    });

    const res = await sendBvnkWebhook({
      event: "bvnk:customers:status-change",
      data: {
        customerId: CUSTOMER_REFERENCE,
        status: "ACTIONS_REQUIRED",
        customerType: "INDIVIDUAL",
      },
    });

    expect(res.status).toBe(200);
    expect(getCustomer).toHaveBeenCalledWith(expect.anything(), {
      reference: CUSTOMER_REFERENCE,
    });
    const customer = (await readBvnk())?.customer;
    expect(customer?.status).toBe("INFO_REQUIRED");
    expect(customer?.verificationUrl).toBe("https://in.sumsub.com/websdk/p/sbx_test");

    getCustomer.mockRestore();
  });

  it("caches bank details on the matching wallet entry on a wallet status-change webhook", async () => {
    const res = await sendBvnkWebhook({
      event: "ledger:v2:wallet:status-change",
      data: {
        id: WALLET_ID,
        status: "ACTIVE",
        customer: { id: CUSTOMER_REFERENCE, name: "Zach Khong" },
        paymentInstruments: [
          {
            type: "FIAT",
            accountNumber: "900473221558",
            bankDetails: { bic: "LEADUS49XXX", name: "LEAD BANK" },
          },
        ],
      },
    });

    expect(res.status).toBe(200);
    const entry = (await readBvnk())?.wallets?.["USD:USDC_SOLANA:dest"];
    expect(entry?.bankAccount?.accountNumber).toBe("900473221558");
    expect(entry?.bankAccount?.bankName).toBe("LEAD BANK");
  });

  it("rejects a webhook with an invalid signature", async () => {
    const res = await sendBvnkWebhook(
      { event: "customer.updated", data: { reference: CUSTOMER_REFERENCE, status: "VERIFIED" } },
      "not-a-valid-signature"
    );
    expect(res.status).toBe(401);
  });
});
