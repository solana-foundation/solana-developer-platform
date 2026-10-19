import { createHmac } from "node:crypto";
import { hashString } from "@sdp/payments/hash";
import { type PaymentTransferStatus, wellKnownMint } from "@sdp/types";
import type { ExecutionContext } from "hono";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { env } from "@/test/helpers/env";
import { startJsonServer } from "@/test/helpers/json-server";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { required } from "@/test/helpers/required";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

vi.mock("@sdp/types", async (importOriginal) => {
  const { mockProviderStages } = await import("@/test/helpers/provider-stages");
  return mockProviderStages(await importOriginal<typeof import("@sdp/types")>());
});

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

const clerkResponses = new Map<string, unknown>();

function mockClerkUserLookup(
  userId: string,
  email: string,
  options: {
    verificationStatus: "verified" | "unverified";
    memberships: Array<{
      role: string;
      organization: Record<string, unknown>;
    }>;
  }
) {
  env.CLERK_SECRET_KEY = "sk_test_clerk_webhook_user_lookup";
  clerkResponses.set(`/users/${userId}`, {
    id: userId,
    primary_email_address_id: "email_primary",
    email_addresses: [
      {
        id: "email_primary",
        email_address: email,
        verification: { status: options.verificationStatus },
      },
    ],
  });
  clerkResponses.set(`/users/${userId}/organization_memberships?limit=500&offset=0`, {
    data: options.memberships,
    total_count: options.memberships.length,
  });
}

describe("Clerk webhooks", () => {
  let clerkServer: Awaited<ReturnType<typeof startJsonServer>>;
  let originalDeploymentMode: "managed" | "self_hosted" | undefined;
  beforeEach(async () => {
    await seedTestDatabase(env);
    clerkResponses.clear();
    clerkServer = await startJsonServer((request) => {
      assert(request.url);
      if (!clerkResponses.has(request.url)) {
        return { status: 404, body: { error: "Unknown test Clerk endpoint" } };
      }
      return { status: 200, body: clerkResponses.get(request.url) };
    });
    env.CLERK_API_URL = clerkServer.url;
    env.CLERK_WEBHOOK_SECRET = WEBHOOK_SECRET;
    originalDeploymentMode = env.SDP_DEPLOYMENT_MODE;
    env.SDP_DEPLOYMENT_MODE = undefined;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await clerkServer.close();
    env.CLERK_WEBHOOK_SECRET = undefined;
    env.CLERK_SECRET_KEY = undefined;
    env.CLERK_API_URL = undefined;
    env.SDP_DEPLOYMENT_MODE = originalDeploymentMode;
    await clearKVStores(env);
  });
  it("creates and updates the SDP organization mapping from Clerk organization events", async () => {
    const created = await simulateClerkWebhook({
      type: "organization.created",
      data: {
        id: "org_clerk_shared_identity",
        name: "Bookface",
        slug: "bookface",
        private_metadata: {
          sdp: {
            tier: "pro",
            providerOverrides: {
              compliance: {
                elliptic: true,
              },
            },
          },
        },
      },
    });
    expect(created.status).toBe(200);
    const createdOrg = await getDb(env)
      .prepare(`SELECT o.id, o.name, o.slug, o.tier, o.settings, aoi.provider_org_id
         FROM organizations o
         JOIN auth_organization_identities aoi ON aoi.organization_id = o.id
         WHERE aoi.provider = 'clerk' AND aoi.provider_org_id = ?`)
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
    expect(
      required(createdOrg).settings ? JSON.parse(required(required(createdOrg).settings)) : null
    ).toMatchObject({
      providerOverrides: {
        compliance: {
          elliptic: true,
        },
      },
    });
    const updated = await simulateClerkWebhook({
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
      .prepare(`SELECT o.name, o.slug, o.tier, o.settings, aoi.slug AS identity_slug
         FROM organizations o
         JOIN auth_organization_identities aoi ON aoi.organization_id = o.id
         WHERE o.id = ?`)
      .bind(required(createdOrg).id)
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
    expect(
      required(updatedOrg).settings ? JSON.parse(required(required(updatedOrg).settings)) : null
    ).toBeNull();
  });
  it("invalidates cached API keys when Clerk deletes an organization", async () => {
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
             (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
           VALUES (?, ?, ?, ?, 'Webhook cache key', 'sk_test_web', ?, 'api_admin', ?, 'active')`)
        .bind(keyId, orgId, projectId, userId, keyHash, JSON.stringify(["*"])),
    ]);
    await seedCachedApiKey(env, keyHash, {
      id: keyId,
      organizationId: orgId,
      projectId,
      role: "api_admin",
      permissions: ["*"],
      environment: "sandbox",
      rateLimitTier: "standard",
      allowedIps: null,
      signingWalletId: null,
      signingWalletIds: [],
      walletBindings: [],
      status: "active",
      expiresAt: null,
      rotationDeadline: null,
    });
    const authedRequest = () =>
      app.request("/v1/api-keys", { headers: { Authorization: `Bearer ${rawKey}` } }, env);
    expect((await authedRequest()).status).toBe(200);
    const res = await simulateClerkWebhook({
      type: "organization.deleted",
      data: { id: clerkOrgId, object: "organization", deleted: true },
    });
    expect(res.status).toBe(200);
    expect((await authedRequest()).status).toBe(401);
  });
  it("defaults new Clerk organizations to enterprise when SDP tier metadata is missing", async () => {
    const created = await simulateClerkWebhook({
      type: "organization.created",
      data: {
        id: "org_clerk_enterprise_default",
        name: "Enterprise By Default",
        slug: "enterprise-by-default",
      },
    });
    expect(created.status).toBe(200);
    const createdOrg = await getDb(env)
      .prepare(`SELECT o.name, o.slug, o.tier
         FROM organizations o
         JOIN auth_organization_identities aoi ON aoi.organization_id = o.id
         WHERE aoi.provider = 'clerk' AND aoi.provider_org_id = ?`)
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
        .prepare(`INSERT INTO auth_user_identities (id, provider, provider_user_id, user_id, email)
           VALUES (?, 'clerk', ?, ?, ?)`)
        .bind("aui_existing", "user_clerk_existing", "usr_clerk_existing", "old@example.com"),
    ]);
    mockClerkUserLookup("user_clerk_existing", "taken@example.com", {
      verificationStatus: "verified",
      memberships: [],
    });
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
    mockClerkUserLookup("user_unverified_collision", "victim@example.com", {
      verificationStatus: "unverified",
      memberships: [
        {
          role: "org:admin",
          organization: {
            id: "org_unverified_collision",
            name: "Unverified Collision Org",
            slug: "unverified-collision-org",
          },
        },
      ],
    });
    const membershipCreated = await simulateClerkWebhook({
      type: "organizationMembership.created",
      data: {
        organization: {
          id: "org_unverified_collision",
          name: "Unverified Collision Org",
          slug: "unverified-collision-org",
        },
        role: "org:admin",
        public_user_data: {
          user_id: "user_unverified_collision",
          identifier: "victim@example.com",
        },
      },
    });
    expect(membershipCreated.status).toBe(200);
    const unverifiedMembership = await getDb(env)
      .prepare(`SELECT om.id
         FROM organization_members om
         JOIN auth_user_identities aui ON aui.user_id = om.user_id
         WHERE aui.provider = 'clerk' AND aui.provider_user_id = ?`)
      .bind("user_unverified_collision")
      .first<{
        id: string;
      }>();
    expect(unverifiedMembership).toBeNull();
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
    const reconciledMembership = await getDb(env)
      .prepare(`SELECT om.role, om.status
         FROM organization_members om
         JOIN auth_user_identities aui ON aui.user_id = om.user_id
         WHERE aui.provider = 'clerk' AND aui.provider_user_id = ?`)
      .bind("user_unverified_collision")
      .first<{
        role: string;
        status: string;
      }>();
    expect(reconciledMembership).toEqual({ role: "admin", status: "active" });
  });
  async function syncMembershipAfterInvitation(invitationStatuses: string[]): Promise<{
    status: string;
  } | null> {
    const clerkOrgId = `org_clerk_revoked_${invitationStatuses.join("_")}`;
    const organizationId = `org_revoked_${invitationStatuses.join("_")}`;
    const email = "withdrawn@example.com";
    const db = getDb(env);
    await db.batch([
      db
        .prepare(
          "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, 'Revoked Invite Org', ?, 'individual', 'active')"
        )
        .bind(organizationId, organizationId),
      db
        .prepare(`INSERT INTO auth_organization_identities (id, provider, provider_org_id, organization_id, slug)
           VALUES (?, 'clerk', ?, ?, ?)`)
        .bind(`aoi_${organizationId}`, clerkOrgId, organizationId, organizationId),
      db
        .prepare(
          "INSERT INTO users (id, email, email_verified, status) VALUES (?, 'revoked-inviter@example.com', 1, 'active')"
        )
        .bind(`usr_inviter_${organizationId}`),
    ]);
    for (const [index, status] of invitationStatuses.entries()) {
      await db
        .prepare(`INSERT INTO invitations
             (id, organization_id, email, role, invited_by, token_hash, expires_at, status, created_at)
           VALUES (?, ?, ?, 'member', ?, ?, ?, ?, ?)`)
        .bind(
          `inv_${organizationId}_${index}`,
          organizationId,
          email,
          `usr_inviter_${organizationId}`,
          `hash_${organizationId}_${index}`,
          new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          status,
          new Date(Date.UTC(2026, 0, index + 1)).toISOString()
        )
        .run();
    }
    mockClerkUserLookup(`user_revoked_${organizationId}`, email, {
      verificationStatus: "verified",
      memberships: [],
    });
    const response = await simulateClerkWebhook({
      type: "organizationMembership.created",
      data: {
        organization: { id: clerkOrgId, name: "Revoked Invite Org", slug: organizationId },
        role: "org:member",
        public_user_data: { user_id: `user_revoked_${organizationId}`, identifier: email },
      },
    });
    expect(response.status).toBe(200);
    return db
      .prepare(`SELECT om.status
           FROM organization_members om
           JOIN users u ON u.id = om.user_id
          WHERE om.organization_id = ? AND u.email = ?`)
      .bind(organizationId, email)
      .first<{
        status: string;
      }>();
  }
  it("declines a Clerk membership when the invitation was revoked", async () => {
    expect(await syncMembershipAfterInvitation(["revoked"])).toBeNull();
  });
  it("admits a Clerk membership when a revoked invitation was superseded by a new one", async () => {
    const membership = await syncMembershipAfterInvitation(["revoked", "pending"]);
    expect(required(membership).status).toBe("active");
  });
  it("syncs organization memberships without creating records on delete-only events", async () => {
    const deleteOnly = await simulateClerkWebhook({
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
      .prepare(`SELECT organization_id
         FROM auth_organization_identities
         WHERE provider = 'clerk' AND provider_org_id = ?`)
      .bind("org_clerk_delete_only")
      .first<{
        organization_id: string;
      }>();
    expect(missingOrg).toBeNull();
    mockClerkUserLookup("user_clerk_member", "admin@example.com", {
      verificationStatus: "verified",
      memberships: [
        {
          role: "org:admin",
          organization: {
            id: "org_clerk_membership",
            name: "Membership Org",
            slug: "membership-org",
          },
        },
      ],
    });
    const created = await simulateClerkWebhook({
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
      .prepare(`SELECT u.email, om.user_id, om.organization_id, om.role, om.status
         FROM organization_members om
         JOIN users u ON u.id = om.user_id
         JOIN auth_user_identities aui ON aui.user_id = u.id
         WHERE aui.provider = 'clerk' AND aui.provider_user_id = ?`)
      .bind("user_clerk_member")
      .first<{
        email: string;
        user_id: string;
        organization_id: string;
        role: string;
        status: string;
      }>();
    expect(membership).toMatchObject({
      email: "admin@example.com",
      role: "admin",
      status: "active",
    });
    assert(membership, "Expected the Clerk membership to exist");
    const roleUpdated = await simulateClerkWebhook({
      type: "organizationMembership.updated",
      data: {
        organization: {
          id: "org_clerk_membership",
          name: "Membership Org",
          slug: "membership-org",
        },
        role: "org:member",
        public_user_data: {
          user_id: "user_clerk_member",
          identifier: "admin@example.com",
        },
      },
    });
    expect(roleUpdated.status).toBe(200);
    const deleted = await simulateClerkWebhook({
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
      .prepare(`SELECT om.status
         FROM organization_members om
         JOIN auth_user_identities aui ON aui.user_id = om.user_id
         WHERE aui.provider = 'clerk' AND aui.provider_user_id = ?`)
      .bind("user_clerk_member")
      .first<{
        status: string;
      }>();
    expect(required(removed).status).toBe("removed");
    const delayedUserUpdate = await simulateClerkWebhook({
      type: "user.updated",
      data: {
        id: "user_clerk_member",
        primary_email_address_id: "email_primary",
        email_addresses: [
          {
            id: "email_primary",
            email_address: "admin@example.com",
            verification: { status: "verified" },
          },
        ],
      },
    });
    expect(delayedUserUpdate.status).toBe(200);
    const stillRemoved = await getDb(env)
      .prepare(`SELECT om.status
         FROM organization_members om
         JOIN auth_user_identities aui ON aui.user_id = om.user_id
         WHERE aui.provider = 'clerk' AND aui.provider_user_id = ?`)
      .bind("user_clerk_member")
      .first<{
        status: string;
      }>();
    expect(required(stillRemoved).status).toBe("removed");
    const readded = await simulateClerkWebhook({
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
          identifier: "admin@example.com",
        },
      },
    });
    expect(readded.status).toBe(200);
    const activeAgain = await getDb(env)
      .prepare(`SELECT om.status
         FROM organization_members om
         JOIN auth_user_identities aui ON aui.user_id = om.user_id
         WHERE aui.provider = 'clerk' AND aui.provider_user_id = ?`)
      .bind("user_clerk_member")
      .first<{
        status: string;
      }>();
    expect(required(activeAgain).status).toBe("active");
  });
  it("syncs user lifecycle and Clerk organization deletion", async () => {
    mockClerkUserLookup("user_clerk_lifecycle", "member@example.com", {
      verificationStatus: "verified",
      memberships: [],
    });
    await simulateClerkWebhook({
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
    const updatedUser = await simulateClerkWebhook({
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
            verification: { status: "verified" },
          },
        ],
      },
    });
    expect(updatedUser.status).toBe(200);
    const user = await getDb(env)
      .prepare(`SELECT u.id, u.email, u.name, u.status
         FROM users u
         JOIN auth_user_identities aui ON aui.user_id = u.id
         WHERE aui.provider = 'clerk' AND aui.provider_user_id = ?`)
      .bind("user_clerk_lifecycle")
      .first<{
        id: string;
        email: string;
        name: string | null;
        status: string;
      }>();
    expect(user).toMatchObject({
      email: "ada@example.com",
      name: "Ada Lovelace",
      status: "active",
    });
    const userId = required(user).id;
    expect(userId).toBeTruthy();
    assert(userId, "Expected the Clerk user mapping to exist");
    const organization = await getDb(env)
      .prepare(`SELECT organization_id
         FROM auth_organization_identities
         WHERE provider = 'clerk' AND provider_org_id = ?`)
      .bind("org_clerk_lifecycle")
      .first<{
        organization_id: string;
      }>();
    assert(organization, "Expected the Clerk organization mapping to exist");
    const apiKeyHash = "webhook_lifecycle_key_hash";
    const lifecycleProject = await getDb(env)
      .prepare(`SELECT p.id
         FROM projects p
         JOIN auth_organization_identities aoi ON aoi.organization_id = p.organization_id
         WHERE aoi.provider = 'clerk' AND aoi.provider_org_id = ? AND p.environment = 'sandbox'`)
      .bind("org_clerk_lifecycle")
      .first<{
        id: string;
      }>();
    assert(lifecycleProject, "Expected the Clerk organization sandbox project to exist");
    await getDb(env)
      .prepare(`INSERT INTO api_keys
         (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, status)
         SELECT ?, aoi.organization_id, ?, ?, ?, ?, ?, ?, ?
         FROM auth_organization_identities aoi
         WHERE aoi.provider = 'clerk' AND aoi.provider_org_id = ?`)
      .bind(
        "key_webhook_lifecycle",
        lifecycleProject.id,
        userId,
        "Lifecycle Key",
        "sk_test_web",
        apiKeyHash,
        "api_admin",
        "active",
        "org_clerk_lifecycle"
      )
      .run();
    const deletedUser = await simulateClerkWebhook({
      type: "user.deleted",
      data: {
        id: "user_clerk_lifecycle",
      },
    });
    expect(deletedUser.status).toBe(200);
    const removedUser = await getDb(env)
      .prepare("SELECT status FROM users WHERE id = ?")
      .bind(userId)
      .first<{
        status: string;
      }>();
    expect(required(removedUser).status).toBe("deleted");
    await getDb(env)
      .prepare(
        `INSERT INTO invitations (id, organization_id, email, role, invited_by, token_hash, expires_at, status)
         VALUES (?, ?, ?, 'member', ?, ?, ?, 'pending')`
      )
      .bind(
        "inv_clerk_lifecycle_pending",
        organization.organization_id,
        "pending@example.com",
        userId,
        "hash_clerk_lifecycle_pending",
        "2099-01-01T00:00:00.000Z"
      )
      .run();
    const deletedOrg = await simulateClerkWebhook({
      type: "organization.deleted",
      data: {
        id: "org_clerk_lifecycle",
      },
    });
    expect(deletedOrg.status).toBe(200);
    // A pending invitation would be a way back in; deletion revokes it.
    const invitation = await getDb(env)
      .prepare("SELECT status FROM invitations WHERE id = ?")
      .bind("inv_clerk_lifecycle_pending")
      .first<{ status: string }>();
    expect(invitation?.status).toBe("revoked");
    const lifecycleState = await getDb(env)
      .prepare(`SELECT o.status AS org_status, om.status AS member_status, ak.status AS api_key_status
         FROM auth_organization_identities aoi
         JOIN organizations o ON o.id = aoi.organization_id
         JOIN organization_members om ON om.organization_id = o.id
         JOIN api_keys ak ON ak.organization_id = o.id
         WHERE aoi.provider = 'clerk' AND aoi.provider_org_id = ?`)
      .bind("org_clerk_lifecycle")
      .first<{
        org_status: string;
        member_status: string;
        api_key_status: string;
      }>();
    expect(lifecycleState).toEqual({
      org_status: "deleted",
      member_status: "removed",
      api_key_status: "revoked",
    });
  });
});

describe("MoonPay ramp webhook", () => {
  const ORG_ID = "org_moonpay_webhook";
  const PROJECT_ID = "prj_moonpay_webhook";
  const USER_ID = "usr_moonpay_webhook";
  const TRANSFER_ID = "xfr_moonpay_webhook";
  const MOONPAY_TRANSACTION_ID = "0a5bb889-9afb-4b8d-835b-9b9855d67509";
  const MOONPAY_WEBHOOK_KEY = "moonpay_test_webhook_key";
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
    env.MOONPAY_SANDBOX_WEBHOOK_KEY = MOONPAY_WEBHOOK_KEY;
    await seedMoonpayOnrampTransfer();
  });
  afterEach(async () => {
    env.MOONPAY_SANDBOX_WEBHOOK_KEY = undefined;
  });
  const completedPayload = {
    type: "transaction_updated",
    externalCustomerId: "MOONPAY-ONRAMP-0001",
    data: {
      id: MOONPAY_TRANSACTION_ID,
      status: "completed",
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
  it("records the delivered crypto amount and per-provider economics on a completed webhook", async () => {
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
    expect(required(transfer).status).toBe("completed");
    expect(required(transfer).amount).toBe("0.649");
    expect(required(transfer).provider_reference).toBe(MOONPAY_TRANSACTION_ID);
    expect(required(transfer).destination_address).toBe(
      "WebhookDestinationSolanaWallet111111111111111111"
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
      status: "completed",
      amount: "0.2",
      fiat_amount: "16.31",
      source_address: sourceAddress,
      destination_address: destinationAddress,
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
  it("still marks a transfer failed when an early-stage failure omits economics", async () => {
    const res = await sendMoonpayWebhook({
      type: "transaction_failed",
      externalCustomerId: "MOONPAY-ONRAMP-0001",
      data: {
        id: MOONPAY_TRANSACTION_ID,
        status: "failed",
        externalTransactionId: TRANSFER_ID,
        failureReason: "kyc_rejected",
      },
    });
    expect(res.status).toBe(200);
    const transfer = await getDb(env)
      .prepare("SELECT status, error, provider_data FROM payment_transfers WHERE id = ?")
      .bind(TRANSFER_ID)
      .first<{
        status: string;
        error: string | null;
        provider_data: {
          settlement?: unknown;
        };
      }>();
    expect(required(transfer).status).toBe("failed");
    expect(required(transfer).error).toBe("kyc_rejected");
    expect(required(transfer).provider_data.settlement).toBeUndefined();
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
