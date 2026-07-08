import { createHmac, createSign, generateKeyPairSync } from "node:crypto";
import { Webhook } from "svix";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { RAMP_PROVIDER_CLIENTS } from "@/lib/ramps";
import {
  buildBvnkCustomerExternalReference,
  buildBvnkOfframpReference,
  buildBvnkOnrampPaymentRuleKey,
  buildBvnkOnrampWalletName,
} from "@/lib/ramps/providers/bvnk/provider-data";
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
  const COUNTERPARTY_ID = "counterparty_123e4567-e89b-12d3-a456-426614174000";
  const CUSTOMER_REFERENCE = "965a5ef5-77f3-482e-917f-194c30143810";
  const USER_ID = "usr_bvnk_webhook";
  const WALLET_ID = "a:1:wallet:1";
  const CUSTOMER_EXTERNAL_REFERENCE = buildBvnkCustomerExternalReference(COUNTERPARTY_ID);
  const ONRAMP_PAYMENT_RULE_KEY = buildBvnkOnrampPaymentRuleKey("USD", "USDC", "SOLANA", "dest");
  const ONRAMP_WALLET_NAME = buildBvnkOnrampWalletName(COUNTERPARTY_ID, ONRAMP_PAYMENT_RULE_KEY);

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
        {
          firstName: "Webhook",
          lastName: "Buyer",
          dateOfBirth: "1990-01-15",
          phone: "+14155551234",
          address: { line1: "1 Market St", city: "San Francisco", countryCode: "US" },
        },
        {
          bvnk: {
            customer: {
              customerReference: CUSTOMER_REFERENCE,
              externalReference: CUSTOMER_EXTERNAL_REFERENCE,
              status: "PENDING",
            },
            wallets: { [ONRAMP_PAYMENT_RULE_KEY]: { walletId: WALLET_ID } },
          },
        },
        null
      )
      .run();
  }

  async function sendBvnkWebhook(payload: unknown, signature?: string) {
    const body = JSON.stringify({
      ...(payload as Record<string, unknown>),
      timestamp: new Date().toISOString(),
    });
    const sig =
      signature ?? createHmac("sha256", BVNK_WEBHOOK_SECRET).update(body).digest("base64");
    const background: Promise<unknown>[] = [];
    const executionCtx: ExecutionContext = {
      waitUntil(promise) {
        background.push(promise);
      },
      passThroughOnException() {},
      props: {},
    };
    const res = await app.request(
      "/webhooks/payments/ramps/sandbox/bvnk",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Signature": sig },
        body,
      },
      env,
      executionCtx
    );
    await Promise.allSettled(background);
    return res;
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
              {
                walletId?: string;
                ruleId?: string;
                bankAccount?: { accountNumber?: string; bankName?: string };
              }
            >;
          };
        };
      }>();
    return row?.provider_data.bvnk;
  }

  it("flips the cached customer status to VERIFIED on a customers:status-change webhook", async () => {
    const res = await sendBvnkWebhook({
      event: "bvnk:customers:status-change",
      data: {
        customerId: CUSTOMER_REFERENCE,
        status: "VERIFIED",
        customerType: "INDIVIDUAL",
      },
    });

    expect(res.status).toBe(200);
    expect((await readBvnk())?.customer?.status).toBe("VERIFIED");
  });

  it("provisions the funding wallet and payment rule after customer verification succeeds", async () => {
    await getDb(env)
      .prepare("UPDATE counterparties SET provider_data = ? WHERE id = ?")
      .bind(
        {
          bvnk: {
            customer: {
              customerReference: CUSTOMER_REFERENCE,
              externalReference: CUSTOMER_EXTERNAL_REFERENCE,
              status: "PENDING",
            },
            wallets: {
              [ONRAMP_PAYMENT_RULE_KEY]: {
                request: {
                  fiatCurrency: "USD",
                  currency: "USDC",
                  network: "SOLANA",
                  destinationWalletAddress: "dest",
                },
              },
            },
          },
        },
        COUNTERPARTY_ID
      )
      .run();

    const getProfile = vi
      .spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "getFiatWalletProfile")
      .mockResolvedValue("profile_webhook_1");
    const createWallet = vi
      .spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "createFiatWallet")
      .mockResolvedValue({
        id: WALLET_ID,
        name: ONRAMP_WALLET_NAME,
        status: "ACTIVE",
        bankAccount: {
          accountNumber: "900473221558",
          bankName: "LEAD BANK",
        },
      });
    const createRule = vi
      .spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "createOnrampRule")
      .mockResolvedValue({ id: "rule_webhook_verified_1", status: "ACTIVE" });

    const res = await sendBvnkWebhook({
      event: "bvnk:customers:status-change",
      data: {
        customerId: CUSTOMER_REFERENCE,
        status: "VERIFIED",
        customerType: "INDIVIDUAL",
      },
    });

    expect(res.status).toBe(200);
    expect(getProfile).toHaveBeenCalledTimes(1);
    expect(createWallet).toHaveBeenCalledTimes(1);
    expect(createRule).toHaveBeenCalledTimes(1);

    const entry = (await readBvnk())?.wallets?.[ONRAMP_PAYMENT_RULE_KEY];
    expect(entry?.walletId).toBe(WALLET_ID);
    expect(entry?.ruleId).toBe("rule_webhook_verified_1");

    getProfile.mockRestore();
    createWallet.mockRestore();
    createRule.mockRestore();
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
        name: ONRAMP_WALLET_NAME,
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
    const entry = (await readBvnk())?.wallets?.[ONRAMP_PAYMENT_RULE_KEY];
    expect(entry?.bankAccount?.accountNumber).toBe("900473221558");
    expect(entry?.bankAccount?.bankName).toBe("LEAD BANK");
  });

  it("creates the payment rule when a wallet activates for a verified customer", async () => {
    await getDb(env)
      .prepare("UPDATE counterparties SET provider_data = ? WHERE id = ?")
      .bind(
        {
          bvnk: {
            customer: {
              customerReference: CUSTOMER_REFERENCE,
              externalReference: CUSTOMER_EXTERNAL_REFERENCE,
              status: "VERIFIED",
            },
            wallets: {
              [ONRAMP_PAYMENT_RULE_KEY]: {
                walletId: WALLET_ID,
                walletStatus: "PENDING",
                request: {
                  fiatCurrency: "USD",
                  currency: "USDC",
                  network: "SOLANA",
                  destinationWalletAddress: "dest",
                },
              },
            },
          },
        },
        COUNTERPARTY_ID
      )
      .run();

    const createRule = vi
      .spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "createOnrampRule")
      .mockResolvedValue({ id: "rule_webhook_1", status: "ACTIVE" });

    const res = await sendBvnkWebhook({
      event: "ledger:v2:wallet:status-change",
      data: {
        id: WALLET_ID,
        name: ONRAMP_WALLET_NAME,
        status: "ACTIVE",
        customer: { id: CUSTOMER_REFERENCE, name: "Webhook Buyer" },
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
    expect(createRule).toHaveBeenCalledTimes(1);

    const row = await getDb(env)
      .prepare("SELECT provider_data FROM counterparties WHERE id = ?")
      .bind(COUNTERPARTY_ID)
      .first<{
        provider_data: {
          bvnk?: {
            wallets?: Record<string, { ruleId?: string; bankAccount?: { accountNumber?: string } }>;
          };
        };
      }>();
    const entry = row?.provider_data.bvnk?.wallets?.[ONRAMP_PAYMENT_RULE_KEY];
    expect(entry?.ruleId).toBe("rule_webhook_1");
    expect(entry?.bankAccount?.accountNumber).toBe("900473221558");

    createRule.mockRestore();
  });

  it("activates the off-ramp wallet on a wallet status-change webhook with no customer", async () => {
    const OFFRAMP_WALLET_ID = "a:offramp:wallet:1";
    await getDb(env)
      .prepare("UPDATE counterparties SET provider_data = ? WHERE id = ?")
      .bind(
        {
          bvnk: {
            offramp: {
              wallets: { USD: { id: OFFRAMP_WALLET_ID, status: "PENDING" } },
              beneficiaries: {
                "USD:abc123": {
                  key: "USD:abc123",
                  fiatCurrency: "USD",
                  accountType: "ACH",
                  createdAt: "2026-06-01T00:00:00.000Z",
                },
              },
            },
          },
        },
        COUNTERPARTY_ID
      )
      .run();

    const res = await sendBvnkWebhook({
      event: "ledger:v2:wallet:status-change",
      data: {
        id: OFFRAMP_WALLET_ID,
        status: "ACTIVE",
        name: `sdp:offramp:USD:${COUNTERPARTY_ID}`,
      },
    });

    expect(res.status).toBe(200);
    const row = await getDb(env)
      .prepare("SELECT provider_data FROM counterparties WHERE id = ?")
      .bind(COUNTERPARTY_ID)
      .first<{
        provider_data: {
          bvnk?: { offramp?: { wallets?: Record<string, { id?: string; status?: string }> } };
        };
      }>();
    expect(row?.provider_data.bvnk?.offramp?.wallets?.USD?.status).toBe("ACTIVE");
  });

  it("clears a stale provisioningError when a retry makes forward progress", async () => {
    await getDb(env)
      .prepare("UPDATE counterparties SET provider_data = ? WHERE id = ?")
      .bind(
        {
          bvnk: {
            customer: {
              customerReference: CUSTOMER_REFERENCE,
              externalReference: CUSTOMER_EXTERNAL_REFERENCE,
              status: "VERIFIED",
            },
            wallets: {
              [ONRAMP_PAYMENT_RULE_KEY]: {
                walletId: WALLET_ID,
                walletStatus: "PENDING",
                provisioningError: "BVNK rule creation failed",
                request: {
                  fiatCurrency: "USD",
                  currency: "USDC",
                  network: "SOLANA",
                  destinationWalletAddress: "dest",
                },
              },
            },
          },
        },
        COUNTERPARTY_ID
      )
      .run();

    const getWallet = vi
      .spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "getFiatWallet")
      .mockResolvedValue({ id: WALLET_ID, status: "PENDING" });

    const res = await sendBvnkWebhook({
      event: "bvnk:customers:status-change",
      data: {
        customerId: CUSTOMER_REFERENCE,
        status: "VERIFIED",
        customerType: "INDIVIDUAL",
      },
    });

    expect(res.status).toBe(200);
    const row = await getDb(env)
      .prepare("SELECT provider_data FROM counterparties WHERE id = ?")
      .bind(COUNTERPARTY_ID)
      .first<{
        provider_data: {
          bvnk?: { wallets?: Record<string, { provisioningError?: string; ruleId?: string }> };
        };
      }>();
    const entry = row?.provider_data.bvnk?.wallets?.[ONRAMP_PAYMENT_RULE_KEY];
    expect(entry?.provisioningError).toBeUndefined();
    expect(entry?.ruleId).toBeUndefined();

    getWallet.mockRestore();
  });

  it("completes an on-ramp transfer from a payment webhook using the SDP customer reference", async () => {
    const ruleId = "rule_webhook_payment_1";
    const transferId = "pt_bvnk_webhook_payment";
    const providerReference = "bvnk_onramp_quote_webhook_1";
    await getDb(env)
      .prepare("UPDATE counterparties SET provider_data = ? WHERE id = ?")
      .bind(
        {
          bvnk: {
            customer: {
              customerReference: CUSTOMER_REFERENCE,
              externalReference: CUSTOMER_EXTERNAL_REFERENCE,
              status: "VERIFIED",
            },
            wallets: {
              [ONRAMP_PAYMENT_RULE_KEY]: {
                walletId: WALLET_ID,
                ruleId,
                request: {
                  fiatCurrency: "USD",
                  currency: "USDC",
                  network: "SOLANA",
                  destinationWalletAddress: "dest",
                },
              },
            },
          },
        },
        COUNTERPARTY_ID
      )
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_transfers (
           id, organization_id, project_id, wallet_id, counterparty_id, source_address, destination_address,
           token, amount, memo, type, direction, status, provider, provider_reference,
           delivery_mode, fiat_currency, fiat_amount, provider_data, signature, serialized_tx,
           initiated_by_key_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?)`
      )
      .bind(
        transferId,
        ORG_ID,
        PROJECT_ID,
        "wallet_bvnk_webhook",
        COUNTERPARTY_ID,
        null,
        "dest",
        "USDC",
        null,
        null,
        "onramp",
        "inbound",
        "awaiting_payment",
        "bvnk",
        providerReference,
        "manual_instructions",
        "USD",
        "100.00",
        JSON.stringify({ bvnk: { ruleId, fundingWalletId: WALLET_ID } }),
        null,
        null,
        null,
        "2026-06-05T00:00:00.000Z",
        "2026-06-05T00:00:00.000Z"
      )
      .run();

    const res = await sendBvnkWebhook({
      event: "bvnk:payment:payin:status-change",
      data: {
        customerReference: CUSTOMER_REFERENCE,
        beneficiary: { walletId: WALLET_ID },
        status: "COMPLETED",
        amount: { value: 100, currencyCode: "USD" },
      },
    });

    expect(res.status).toBe(200);
    const transfer = await getDb(env)
      .prepare("SELECT status, amount, fiat_amount FROM payment_transfers WHERE id = ?")
      .bind(transferId)
      .first<{ status: string; amount: string | null; fiat_amount: string | null }>();
    expect(transfer?.status).toBe("completed");
    expect(Number(transfer?.amount)).toBe(100);
    expect(Number(transfer?.fiat_amount)).toBe(100);
  });

  it("moves a BVNK off-ramp transfer to settling when a channel transaction is detected", async () => {
    const transferId = "xfr_d7a72b93-cd7e-405b-96b5-73ca368a7bd7";
    await getDb(env)
      .prepare(
        `INSERT INTO payment_transfers (
           id, organization_id, project_id, wallet_id, source_address, destination_address,
           token, amount, memo, type, direction, status, provider, provider_reference,
           delivery_mode, fiat_currency, fiat_amount, provider_data, signature, serialized_tx,
           initiated_by_key_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        transferId,
        ORG_ID,
        PROJECT_ID,
        "wallet_bvnk_webhook",
        "source_address",
        null,
        "USDC",
        "5",
        null,
        "offramp",
        "outbound",
        "awaiting_payment",
        "bvnk",
        "019f0ce4-98ab-7424-a968-fc323266b8ed",
        "manual_instructions",
        "USD",
        null,
        {},
        null,
        null,
        null,
        "2026-06-28T06:22:15.239Z",
        "2026-06-28T06:22:17.258Z"
      )
      .run();

    const res = await sendBvnkWebhook({
      event: "bvnk:payment:channel:transaction-detected",
      eventId: "019f0ce4-c81e-7000-8000-000000000000",
      data: {
        channelId: "019f0ce4-98ab-7424-a968-fc323266b8ed",
        merchantDisplayName: `sdp:offramp:USD:${COUNTERPARTY_ID}`,
        reference: buildBvnkOfframpReference(transferId),
        dateCreated: 1782627747852,
        lastUpdated: 1782627747852,
        status: "DETECTED",
        uuid: "019f0ce4-c7c2-7a12-ac86-9f1820ff48e1",
        hash: "3B9neiFe2HG3P8ovttfH1XrppubeFtMcKWZDhw9rzLUqUSQrfLYdzpC3v3ctsbtQBt1rwUPkBaa4SWG2SZzqtXD2",
        address: "H8j6ZdeUt1D3GexMhUs6mSrncK7r4KkspKuLVhpsA7V6",
        paidCurrency: "USDC",
        displayCurrency: "USD",
        walletCurrency: "USD",
        feeCurrency: "USD",
        paidAmount: 0,
        displayAmount: 0,
        walletAmount: 0,
        feeAmount: 0,
        sources: null,
      },
    });

    expect(res.status).toBe(200);
    const transfer = await getDb(env)
      .prepare("SELECT status, fiat_amount FROM payment_transfers WHERE id = ?")
      .bind(transferId)
      .first<{ status: string; fiat_amount: string | null }>();
    expect(transfer).toEqual({ status: "settling", fiat_amount: null });
  });

  it("completes a BVNK off-ramp transfer from a confirmed channel transaction", async () => {
    const transferId = "xfr_d7a72b93-cd7e-405b-96b5-73ca368a7bd7";
    await getDb(env)
      .prepare(
        `INSERT INTO payment_transfers (
           id, organization_id, project_id, wallet_id, source_address, destination_address,
           token, amount, memo, type, direction, status, provider, provider_reference,
           delivery_mode, fiat_currency, fiat_amount, provider_data, signature, serialized_tx,
           initiated_by_key_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        transferId,
        ORG_ID,
        PROJECT_ID,
        "wallet_bvnk_webhook",
        "source_address",
        null,
        "USDC",
        "5",
        null,
        "offramp",
        "outbound",
        "awaiting_payment",
        "bvnk",
        "019f0ce4-98ab-7424-a968-fc323266b8ed",
        "manual_instructions",
        "USD",
        null,
        {},
        null,
        null,
        null,
        "2026-06-28T06:22:15.239Z",
        "2026-06-28T06:22:17.258Z"
      )
      .run();

    const res = await sendBvnkWebhook({
      event: "bvnk:payment:channel:transaction-confirmed",
      eventId: "019f0ce5-28a6-7000-8000-000000000000",
      data: {
        channelId: "019f0ce4-98ab-7424-a968-fc323266b8ed",
        merchantDisplayName: `sdp:offramp:USD:${COUNTERPARTY_ID}`,
        reference: buildBvnkOfframpReference(transferId),
        dateCreated: 1782627748000,
        lastUpdated: 1782627771174,
        status: "COMPLETE",
        uuid: "019f0ce4-c7c2-7a12-ac86-9f1820ff48e1",
        hash: "3B9neiFe2HG3P8ovttfH1XrppubeFtMcKWZDhw9rzLUqUSQrfLYdzpC3v3ctsbtQBt1rwUPkBaa4SWG2SZzqtXD2",
        address: "H8j6ZdeUt1D3GexMhUs6mSrncK7r4KkspKuLVhpsA7V6",
        paidCurrency: "USDC",
        displayCurrency: "USD",
        walletCurrency: "USD",
        feeCurrency: "USD",
        paidAmount: 5,
        displayAmount: 4.95,
        walletAmount: 4.95,
        feeAmount: 0.04,
        sources: [
          "GSDYH3kHc4iAVHSCrTxxhXLsoQfMLo6eYLPbA3HLgvzg",
          "6zZcSMwGfY7iPkNvBtZksmNr9JCgg9Q1CGDRjtV4f2U9",
        ],
      },
    });

    expect(res.status).toBe(200);
    const transfer = await getDb(env)
      .prepare("SELECT status, fiat_amount FROM payment_transfers WHERE id = ?")
      .bind(transferId)
      .first<{ status: string; fiat_amount: string | null }>();
    expect(transfer).toEqual({ status: "completed", fiat_amount: "4.95" });
  });

  it("rejects a webhook with an invalid signature", async () => {
    const res = await sendBvnkWebhook(
      { event: "customer.updated", data: { reference: CUSTOMER_REFERENCE, status: "VERIFIED" } },
      "not-a-valid-signature"
    );
    expect(res.status).toBe(401);
  });

  it("rejects a bvnk webhook that omits the envelope timestamp", async () => {
    const body = JSON.stringify({
      event: "bvnk:customers:status-change",
      data: {
        customerId: CUSTOMER_REFERENCE,
        status: "VERIFIED",
        customerType: "INDIVIDUAL",
      },
    });
    const sig = createHmac("sha256", BVNK_WEBHOOK_SECRET).update(body).digest("base64");
    const res = await app.request(
      "/webhooks/payments/ramps/sandbox/bvnk",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Signature": sig },
        body,
      },
      env
    );
    expect(res.status).toBe(401);
  });
});

describe("Lightspark ramp webhook", () => {
  const ORG_ID = "org_lightspark_webhook";
  const PROJECT_ID = "prj_lightspark_webhook";
  const USER_ID = "usr_lightspark_webhook";
  const TRANSFER_ID = "pt_lightspark_webhook";
  const QUOTE_ID = "Quote:019e979c-f660-5246-0000-c0588496b9ce";
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });

  type LightsparkOnrampWebhookBase = {
    id: string;
    timestamp?: string;
  };

  type LightsparkOnrampPaymentDataBase = {
    id: string;
    type: "OUTGOING";
    destination: {
      destinationType: "ACCOUNT";
      accountId: string;
    };
    customerId: string;
    platformCustomerId: string;
    createdAt: string;
    updatedAt: string;
    description: string;
    source: {
      sourceType: "REALTIME_FUNDING";
      currency: string;
      customerId: string;
    };
    sentAmount: {
      amount: number;
      currency: {
        code: string;
        name: string;
        symbol: string;
        decimals: number;
      };
    };
    receivedAmount: {
      amount: number;
      currency: {
        code: string;
        name: string;
        symbol: string;
        decimals: number;
      };
    };
    exchangeRate: number;
    fees: number;
    quoteId: string;
    paymentInstructions: readonly {
      accountOrWalletInfo: {
        accountType: "USD_ACCOUNT";
        accountNumber: string;
        routingNumber: string;
        paymentRails: readonly string[];
        reference: string;
      };
    }[];
  };

  type LightsparkOnrampWebhookPayload =
    | (LightsparkOnrampWebhookBase & {
        type: "OUTGOING_PAYMENT.PENDING";
        data: LightsparkOnrampPaymentDataBase & { status: "PENDING" };
      })
    | (LightsparkOnrampWebhookBase & {
        type: "OUTGOING_PAYMENT.PROCESSING";
        data: LightsparkOnrampPaymentDataBase & { status: "PROCESSING" };
      })
    | (LightsparkOnrampWebhookBase & {
        type: "OUTGOING_PAYMENT.COMPLETED";
        data: LightsparkOnrampPaymentDataBase & { status: "COMPLETED"; settledAt: string };
      });

  const LIGHTSPARK_ONRAMP_PAYMENT_DATA = {
    id: "Transaction:019e979c-f671-b78f-0000-2154aedf309b",
    type: "OUTGOING",
    destination: {
      destinationType: "ACCOUNT",
      accountId: "ExternalAccount:019e92fe-cc69-6abf-0000-973b67b36284",
    },
    customerId: "Customer:019e92fe-c8b0-938e-0000-35ae407d1719",
    platformCustomerId: "counterparty_8eac0e73-775a-419c-a2c0-6310ee4d1a78",
    createdAt: "2026-06-05T11:48:26.865811Z",
    description: "SDP onramp",
    source: {
      sourceType: "REALTIME_FUNDING",
      currency: "USD",
      customerId: "Customer:019e92fe-c8b0-938e-0000-35ae407d1719",
    },
    sentAmount: {
      amount: 2500,
      currency: {
        code: "USD",
        name: "US Dollar",
        symbol: "$",
        decimals: 2,
      },
    },
    receivedAmount: {
      amount: 25000000,
      currency: {
        code: "USDC",
        name: "USD Coin",
        symbol: "usdc",
        decimals: 6,
      },
    },
    exchangeRate: 0.0001,
    fees: 0,
    quoteId: QUOTE_ID,
    paymentInstructions: [
      {
        accountOrWalletInfo: {
          accountType: "USD_ACCOUNT",
          accountNumber: "1111222233331111",
          routingNumber: "021000021",
          paymentRails: ["ACH", "WIRE", "RTP", "FEDNOW"],
          reference: "f2c49316-e3f0-4b56-9eb8-0add69210092",
        },
      },
    ],
  } as const satisfies Omit<LightsparkOnrampPaymentDataBase, "updatedAt">;

  async function seedLightsparkTransfer() {
    await getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(ORG_ID, "Lightspark Webhook Org", "lightspark-webhook-org", "enterprise", "active")
      .run();
    await getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
      .bind(USER_ID, "lightspark-webhook-user@example.com", 1, "active")
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(PROJECT_ID, ORG_ID, "Test", "lightspark-webhook-proj", "sandbox", "active", USER_ID)
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_transfers (
           id, organization_id, project_id, wallet_id, source_address, destination_address,
           token, amount, memo, type, direction, status, provider, provider_reference,
           delivery_mode, fiat_currency, fiat_amount, provider_data, signature, serialized_tx,
           initiated_by_key_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        TRANSFER_ID,
        ORG_ID,
        PROJECT_ID,
        "wallet_lightspark_webhook",
        null,
        "DestinationSolanaWallet111111111111111111111111",
        "BTC",
        null,
        null,
        "onramp",
        "inbound",
        "awaiting_payment",
        "lightspark",
        QUOTE_ID,
        "manual_instructions",
        "USD",
        "100.00",
        {},
        null,
        null,
        null,
        "2026-06-05T00:00:00.000Z",
        "2026-06-05T00:00:00.000Z"
      )
      .run();
  }

  async function sendLightsparkWebhook(payload: LightsparkOnrampWebhookPayload) {
    const body = JSON.stringify({ ...payload, timestamp: new Date().toISOString() });
    const signature = createSign("SHA256").update(body).sign(privateKey).toString("base64");
    const background: Promise<unknown>[] = [];
    const executionCtx: ExecutionContext = {
      waitUntil(promise) {
        background.push(promise);
      },
      passThroughOnException() {},
      props: {},
    };
    const res = await app.request(
      "/webhooks/payments/ramps/sandbox/lightspark",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Grid-Signature": JSON.stringify({ v: 1, s: signature }),
        },
        body,
      },
      env,
      executionCtx
    );
    await Promise.allSettled(background);
    return res;
  }

  beforeEach(async () => {
    await seedTestDatabase(env);
    env.LIGHTSPARK_GRID_SANDBOX_WEBHOOK_PUBLIC_KEY = publicKey
      .export({ type: "spki", format: "pem" })
      .toString();
    await seedLightsparkTransfer();
  });

  afterEach(async () => {
    env.LIGHTSPARK_GRID_SANDBOX_WEBHOOK_PUBLIC_KEY = undefined;
    await clearTestDatabase(env);
  });

  it("marks a lightspark onramp transfer awaiting payment from the quote-time PENDING webhook", async () => {
    const res = await sendLightsparkWebhook({
      id: "Webhook:019e979c-f68e-52c1-0000-3acafedca6e8",
      type: "OUTGOING_PAYMENT.PENDING",
      data: {
        ...LIGHTSPARK_ONRAMP_PAYMENT_DATA,
        status: "PENDING",
        updatedAt: "2026-06-05T11:48:26.865811Z",
      },
    });

    expect(res.status).toBe(200);

    const transfer = await getDb(env)
      .prepare("SELECT status FROM payment_transfers WHERE id = ?")
      .bind(TRANSFER_ID)
      .first<{ status: string }>();
    expect(transfer).toEqual({ status: "awaiting_payment" });
  });

  it("marks a lightspark onramp transfer settling from an OUTGOING_PAYMENT.PROCESSING webhook", async () => {
    const res = await sendLightsparkWebhook({
      id: "Webhook:019e979f-89d8-52c1-0000-2b4e2eaa4a8e",
      type: "OUTGOING_PAYMENT.PROCESSING",
      data: {
        ...LIGHTSPARK_ONRAMP_PAYMENT_DATA,
        status: "PROCESSING",
        updatedAt: "2026-06-05T11:51:15.639479Z",
      },
    });

    expect(res.status).toBe(200);

    const transfer = await getDb(env)
      .prepare("SELECT status FROM payment_transfers WHERE id = ?")
      .bind(TRANSFER_ID)
      .first<{ status: string }>();
    expect(transfer).toEqual({ status: "settling" });
  });

  it("marks a lightspark onramp transfer completed from an OUTGOING_PAYMENT.COMPLETED webhook", async () => {
    const res = await sendLightsparkWebhook({
      id: "Webhook:019e979f-8bf4-52c1-0000-eca039904606",
      type: "OUTGOING_PAYMENT.COMPLETED",
      data: {
        ...LIGHTSPARK_ONRAMP_PAYMENT_DATA,
        status: "COMPLETED",
        updatedAt: "2026-06-05T11:51:16.174911Z",
        settledAt: "2026-06-05T11:51:16.175534Z",
      },
    });

    expect(res.status).toBe(200);

    const transfer = await getDb(env)
      .prepare("SELECT status FROM payment_transfers WHERE id = ?")
      .bind(TRANSFER_ID)
      .first<{ status: string }>();
    expect(transfer).toEqual({ status: "completed" });
  });

  const OFFRAMP_TRANSFER_ID = "pt_lightspark_offramp_webhook";
  const OFFRAMP_QUOTE_ID = "Quote:019eb56d-f06c-5246-0000-c18574f65f2a";

  async function seedLightsparkOfframpTransfer() {
    await getDb(env)
      .prepare(
        `INSERT INTO payment_transfers (
           id, organization_id, project_id, wallet_id, source_address, destination_address,
           token, amount, memo, type, direction, status, provider, provider_reference,
           delivery_mode, fiat_currency, fiat_amount, provider_data, signature, serialized_tx,
           initiated_by_key_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        OFFRAMP_TRANSFER_ID,
        ORG_ID,
        PROJECT_ID,
        "wallet_lightspark_webhook",
        "SourceSolanaWallet1111111111111111111111111111",
        null,
        "USDC",
        "10",
        null,
        "offramp",
        "outbound",
        "awaiting_payment",
        "lightspark",
        OFFRAMP_QUOTE_ID,
        "manual_instructions",
        "USD",
        null,
        {},
        null,
        null,
        null,
        "2026-06-11T00:00:00.000Z",
        "2026-06-11T00:00:00.000Z"
      )
      .run();
  }

  function offrampCompletedWebhook(): LightsparkOnrampWebhookPayload {
    return {
      id: "Webhook:019eb56e-ea4e-52c1-0000-36fa5542e7e6",
      type: "OUTGOING_PAYMENT.COMPLETED",
      data: {
        ...LIGHTSPARK_ONRAMP_PAYMENT_DATA,
        quoteId: OFFRAMP_QUOTE_ID,
        description: "SDP offramp",
        source: {
          sourceType: "REALTIME_FUNDING",
          currency: "USDC",
          customerId: "Customer:019eb1a0-8aa2-938e-0000-36f4d5ac29d2",
        },
        sentAmount: {
          amount: 10000000,
          currency: { code: "USDC", name: "USD Coin", symbol: "usdc", decimals: 6 },
        },
        receivedAmount: {
          amount: 999,
          currency: { code: "USD", name: "US Dollar", symbol: "$", decimals: 2 },
        },
        status: "COMPLETED",
        updatedAt: "2026-06-11T06:46:45.550956Z",
        settledAt: "2026-06-11T06:46:45.552374Z",
      },
    };
  }

  it("persists the settled fiat amount on a lightspark offramp COMPLETED webhook", async () => {
    await seedLightsparkOfframpTransfer();

    const res = await sendLightsparkWebhook(offrampCompletedWebhook());
    expect(res.status).toBe(200);

    const transfer = await getDb(env)
      .prepare("SELECT status, fiat_amount FROM payment_transfers WHERE id = ?")
      .bind(OFFRAMP_TRANSFER_ID)
      .first<{ status: string; fiat_amount: string }>();
    expect(transfer).toEqual({ status: "completed", fiat_amount: "9.99" });
  });

  it("does not regress a settled transfer when a stale webhook is redelivered", async () => {
    await seedLightsparkOfframpTransfer();

    const completed = await sendLightsparkWebhook(offrampCompletedWebhook());
    expect(completed.status).toBe(200);

    const stale = await sendLightsparkWebhook({
      id: "Webhook:019eb56d-f08b-52c1-0000-90f1e68dc8f8",
      type: "OUTGOING_PAYMENT.PENDING",
      data: {
        ...LIGHTSPARK_ONRAMP_PAYMENT_DATA,
        quoteId: OFFRAMP_QUOTE_ID,
        status: "PENDING",
        updatedAt: "2026-06-11T06:45:41.629605Z",
      },
    });
    expect(stale.status).toBe(200);

    const transfer = await getDb(env)
      .prepare("SELECT status, fiat_amount FROM payment_transfers WHERE id = ?")
      .bind(OFFRAMP_TRANSFER_ID)
      .first<{ status: string; fiat_amount: string }>();
    expect(transfer).toEqual({ status: "completed", fiat_amount: "9.99" });
  });

  it("rejects a lightspark webhook whose signed timestamp is outside the replay window", async () => {
    await seedLightsparkOfframpTransfer();

    const stalePayload = {
      ...offrampCompletedWebhook(),
      timestamp: new Date(Date.now() - 6 * 60 * 1000).toISOString(),
    };
    const body = JSON.stringify(stalePayload);
    const signature = createSign("SHA256").update(body).sign(privateKey).toString("base64");
    const res = await app.request(
      "/webhooks/payments/ramps/sandbox/lightspark",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Grid-Signature": JSON.stringify({ v: 1, s: signature }),
        },
        body,
      },
      env
    );
    expect(res.status).toBe(401);

    const transfer = await getDb(env)
      .prepare("SELECT status FROM payment_transfers WHERE id = ?")
      .bind(OFFRAMP_TRANSFER_ID)
      .first<{ status: string }>();
    expect(transfer?.status).toBe("awaiting_payment");
  });

  it("rejects a lightspark webhook that omits the envelope timestamp", async () => {
    const body = JSON.stringify(offrampCompletedWebhook());
    const signature = createSign("SHA256").update(body).sign(privateKey).toString("base64");
    const res = await app.request(
      "/webhooks/payments/ramps/sandbox/lightspark",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Grid-Signature": JSON.stringify({ v: 1, s: signature }),
        },
        body,
      },
      env
    );
    expect(res.status).toBe(401);
  });
});

describe("MoonPay ramp webhook", () => {
  const ORG_ID = "org_moonpay_webhook";
  const PROJECT_ID = "prj_moonpay_webhook";
  const USER_ID = "usr_moonpay_webhook";
  const TRANSFER_ID = "pt_moonpay_webhook";
  const EXTERNAL_TX_ID = "ramp_quote_moonpay_webhook";
  const MOONPAY_WEBHOOK_KEY = "moonpay_test_webhook_key";

  function moonpaySignatureHeader(
    body: string,
    timestampSeconds: number,
    key = MOONPAY_WEBHOOK_KEY
  ) {
    const s = createHmac("sha256", key).update(`${timestampSeconds}.${body}`).digest("hex");
    return `t=${timestampSeconds},s=${s}`;
  }

  async function sendMoonpayWebhook(payload: unknown) {
    const body = JSON.stringify(payload);
    const header = moonpaySignatureHeader(body, Math.floor(Date.now() / 1000));
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
    await getDb(env)
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(PROJECT_ID, ORG_ID, "Test", "moonpay-webhook-proj", "sandbox", "active", USER_ID)
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_transfers (
           id, organization_id, project_id, wallet_id, source_address, destination_address,
           token, amount, memo, type, direction, status, provider, provider_reference,
           delivery_mode, fiat_currency, fiat_amount, provider_data, signature, serialized_tx,
           initiated_by_key_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        TRANSFER_ID,
        ORG_ID,
        PROJECT_ID,
        "wallet_moonpay_webhook",
        null,
        "DestinationSolanaWallet111111111111111111111111",
        "SOL",
        null,
        null,
        "onramp",
        "inbound",
        "awaiting_payment",
        "moonpay",
        EXTERNAL_TX_ID,
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
    env.MOONPAY_SANDBOX_WEBHOOK_KEY = MOONPAY_WEBHOOK_KEY;
    await seedMoonpayOnrampTransfer();
  });

  afterEach(async () => {
    env.MOONPAY_SANDBOX_WEBHOOK_KEY = undefined;
    await clearTestDatabase(env);
  });

  const completedPayload = {
    type: "transaction_updated",
    externalCustomerId: "MOONPAY-ONRAMP-0001",
    data: {
      id: "0a5bb889-9afb-4b8d-835b-9b9855d67509",
      status: "completed",
      externalTransactionId: EXTERNAL_TX_ID,
      failureReason: null,
      baseCurrencyAmount: 47.73,
      quoteCurrencyAmount: 0.649,
      feeAmount: 2,
      extraFeeAmount: 0,
      networkFeeAmount: 0.27,
      areFeesIncluded: true,
      usdRate: 1,
      cryptoTransactionId: "t11paHKpm79qTHVgSQ4rr9PAqE7ZT87MWpi1f5Nim8XzPyc7aPux",
      baseCurrency: { code: "usd" },
      currency: { code: "sol" },
    },
  };

  it("records the delivered crypto amount and per-provider economics on a completed webhook", async () => {
    const res = await sendMoonpayWebhook(completedPayload);
    expect(res.status).toBe(200);

    const transfer = await getDb(env)
      .prepare("SELECT status, amount, provider_data FROM payment_transfers WHERE id = ?")
      .bind(TRANSFER_ID)
      .first<{
        status: string;
        amount: string | null;
        provider_data: { settlement?: Record<string, unknown> };
      }>();
    expect(transfer?.status).toBe("completed");
    expect(transfer?.amount).toBe("0.649");
    expect(transfer?.provider_data.settlement).toMatchObject({
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

  it("still marks a transfer failed when an early-stage failure omits economics", async () => {
    const res = await sendMoonpayWebhook({
      type: "transaction_failed",
      externalCustomerId: "MOONPAY-ONRAMP-0001",
      data: {
        id: "0a5bb889-9afb-4b8d-835b-9b9855d67509",
        status: "failed",
        externalTransactionId: EXTERNAL_TX_ID,
        failureReason: "kyc_rejected",
      },
    });
    expect(res.status).toBe(200);

    const transfer = await getDb(env)
      .prepare("SELECT status, error, provider_data FROM payment_transfers WHERE id = ?")
      .bind(TRANSFER_ID)
      .first<{ status: string; error: string | null; provider_data: { settlement?: unknown } }>();
    expect(transfer?.status).toBe("failed");
    expect(transfer?.error).toBe("kyc_rejected");
    expect(transfer?.provider_data.settlement).toBeUndefined();
  });

  it("rejects a moonpay webhook whose signed timestamp is outside the replay window", async () => {
    const body = JSON.stringify(completedPayload);
    const staleHeader = moonpaySignatureHeader(body, Math.floor(Date.now() / 1000) - 6 * 60);
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
      .first<{ status: string }>();
    expect(transfer?.status).toBe("awaiting_payment");
  });

  it("rejects a moonpay webhook with an invalid signature", async () => {
    const body = JSON.stringify(completedPayload);
    const wrongKeyHeader = moonpaySignatureHeader(
      body,
      Math.floor(Date.now() / 1000),
      "wrong_webhook_key"
    );
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
});
