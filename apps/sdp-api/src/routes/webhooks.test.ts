import { createHmac, createSign, generateKeyPairSync } from "node:crypto";
import { hashString } from "@sdp/payments/hash";
import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import {
  BVNK_FUNDING_WALLET_CLAIM_TAKEOVER_MS,
  buildBvnkFundingWalletName,
  buildBvnkOfframpReference,
  buildBvnkWalletIdempotencyKey,
} from "@sdp/payments/ramps/providers/bvnk/provider-data";
import {
  bvnkCustomer,
  bvnkLedgerWallet,
  bvnkWalletProfilesResponse,
} from "@sdp/payments/ramps/providers/bvnk/test-fixtures";
import { BVNK_FUNDING_WALLET_STATUS, type PaymentTransferStatus } from "@sdp/types";
import type { ExecutionContext } from "hono";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import * as repositories from "@/db/repositories";
import type { BvnkCustomerProviderAccountMetadata } from "@/db/repositories/counterparty-provider-account.repository";
import app from "@/index";
import { bvnkCustomerLinkProviderStatus } from "@/routes/counterparty-provider-accounts/handlers";
import { bvnkCustomerRequirementsFromMetadata } from "@/routes/payments/handlers/ramps/bvnk";
import { RAMP_WEBHOOK_EVENT_MAX_ATTEMPTS } from "@/services/jobs/replay-ramp-webhook-events";
import { SessionService } from "@/services/session.service";
import {
  BVNK_WEBHOOK_TIMESTAMP,
  bvnkAgreementSessionStatusChangeEvent,
  bvnkChannelTransactionEvent,
  bvnkCryptoPayoutStatusChangeEvent,
  bvnkPlatformCustomerStatusChangeEvent,
  bvnkPlatformCustomerUpdateEvent,
  bvnkSeedCustomerReference,
  bvnkV1PayinEvent,
  bvnkV2PayinStatusChangeEvent,
  bvnkWalletStatusChangeEvent,
  seedBvnkOnrampCounterpartyAndFundingWallet,
  seedBvnkOnrampPayinApplied,
  seedBvnkOnrampPayoutClaimed,
  seedBvnkOnrampPayoutIssued,
  seedBvnkOnrampTransfer,
} from "@/test/helpers/bvnk";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const WEBHOOK_SECRET = `whsec_${Buffer.from("test_clerk_webhook_secret_1234567890").toString(
  "base64"
)}`;

/**
 * Impersonates Clerk delivering a webhook to our endpoint, signed per the
 * Standard Webhooks scheme: base64 HMAC-SHA256 of `${id}.${timestamp}.${payload}`
 * keyed with the base64-decoded portion of the `whsec_` secret.
 */
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

function mockClerkUserLookup(
  userId: string,
  email: string,
  verificationStatus: "verified" | "unverified" = "verified",
  memberships: Array<{ role: string; organization: Record<string, unknown> }> = []
) {
  env.CLERK_SECRET_KEY = "sk_test_clerk_webhook_user_lookup";
  env.CLERK_API_URL = "https://clerk.example.test/v1";
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    if (url === `${env.CLERK_API_URL}/users/${userId}`) {
      return new Response(
        JSON.stringify({
          id: userId,
          primary_email_address_id: "email_primary",
          email_addresses: [
            {
              id: "email_primary",
              email_address: email,
              verification: { status: verificationStatus },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    expect(url).toBe(
      `${env.CLERK_API_URL}/users/${userId}/organization_memberships?limit=500&offset=0`
    );
    return new Response(
      JSON.stringify({
        data: memberships,
        total_count: memberships.length,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });
}

describe("Clerk webhooks", () => {
  let originalDeploymentMode: "managed" | "self_hosted" | undefined;

  beforeEach(async () => {
    await seedTestDatabase(env);
    env.CLERK_WEBHOOK_SECRET = WEBHOOK_SECRET;
    // Webhook tier sync is gated by deployment mode — these tests verify the
    // managed-mode behavior (sync runs), so explicitly clear any leaked
    // self-hosted setting from .env.local / process env.
    originalDeploymentMode = env.SDP_DEPLOYMENT_MODE;
    env.SDP_DEPLOYMENT_MODE = undefined;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
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

  it("invalidates cached API keys when Clerk deletes an organization", async () => {
    const clerkOrgId = "org_clerk_webhook_cache_invalidation";
    const orgId = "org_webhook_cache_invalidation";
    const projectId = "prj_webhook_cache_invalidation";
    const userId = "usr_webhook_cache_invalidation";
    // Assembled at runtime: the auth middleware only accepts sk_test_/sk_live_
    // prefixed credentials, and a plain literal in that shape trips secret
    // scanners on what is a made-up fixture value.
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
        .prepare(
          `INSERT INTO auth_organization_identities (id, provider, provider_org_id, organization_id, slug)
           VALUES (?, 'clerk', ?, ?, ?)`
        )
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
        .prepare(
          `INSERT INTO api_keys
             (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
           VALUES (?, ?, ?, ?, 'Webhook cache key', 'sk_test_web', ?, 'api_admin', ?, 'active')`
        )
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

    // The cached key must be rejected on the very next request — no waiting
    // out the cache TTL.
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
    mockClerkUserLookup("user_clerk_existing", "taken@example.com");

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
      .prepare(
        `SELECT user_id
         FROM auth_user_identities
         WHERE provider = 'clerk' AND provider_user_id = ?`
      )
      .bind("user_unverified_collision")
      .first<{ user_id: string }>();
    expect(identity).toBeNull();

    mockClerkUserLookup("user_unverified_collision", "victim@example.com", "unverified", [
      {
        role: "org:admin",
        organization: {
          id: "org_unverified_collision",
          name: "Unverified Collision Org",
          slug: "unverified-collision-org",
        },
      },
    ]);
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
      .prepare(
        `SELECT om.id
         FROM organization_members om
         JOIN auth_user_identities aui ON aui.user_id = om.user_id
         WHERE aui.provider = 'clerk' AND aui.provider_user_id = ?`
      )
      .bind("user_unverified_collision")
      .first<{ id: string }>();
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
      .prepare(
        `SELECT user_id
         FROM auth_user_identities
         WHERE provider = 'clerk' AND provider_user_id = ?`
      )
      .bind("user_unverified_collision")
      .first<{ user_id: string }>();
    expect(verifiedIdentity?.user_id).toBe("usr_verified_email_owner");

    const reconciledMembership = await getDb(env)
      .prepare(
        `SELECT om.role, om.status
         FROM organization_members om
         JOIN auth_user_identities aui ON aui.user_id = om.user_id
         WHERE aui.provider = 'clerk' AND aui.provider_user_id = ?`
      )
      .bind("user_unverified_collision")
      .first<{ role: string; status: string }>();
    expect(reconciledMembership).toEqual({ role: "admin", status: "active" });
  });

  /**
   * Seeds a Clerk-linked org plus an invitation in the given state, then has
   * Clerk report the invitee joining. Returns the resulting membership row.
   */
  async function syncMembershipAfterInvitation(
    invitationStatuses: string[]
  ): Promise<{ status: string } | null> {
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
        .prepare(
          `INSERT INTO auth_organization_identities (id, provider, provider_org_id, organization_id, slug)
           VALUES (?, 'clerk', ?, ?, ?)`
        )
        .bind(`aoi_${organizationId}`, clerkOrgId, organizationId, organizationId),
      db
        .prepare(
          "INSERT INTO users (id, email, email_verified, status) VALUES (?, 'revoked-inviter@example.com', 1, 'active')"
        )
        .bind(`usr_inviter_${organizationId}`),
    ]);

    // created_at is set explicitly so "most recent invitation" is deterministic
    // rather than dependent on insert timing within the same second.
    for (const [index, status] of invitationStatuses.entries()) {
      await db
        .prepare(
          `INSERT INTO invitations
             (id, organization_id, email, role, invited_by, token_hash, expires_at, status, created_at)
           VALUES (?, ?, ?, 'member', ?, ?, ?, ?, ?)`
        )
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

    mockClerkUserLookup(`user_revoked_${organizationId}`, email);
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
      .prepare(
        `SELECT om.status
           FROM organization_members om
           JOIN users u ON u.id = om.user_id
          WHERE om.organization_id = ? AND u.email = ?`
      )
      .bind(organizationId, email)
      .first<{ status: string }>();
  }

  it("declines a Clerk membership when the invitation was revoked", async () => {
    // Clerk mints the acceptance link and we cannot expire it, so this sync is
    // the last point that can honour the revocation.
    expect(await syncMembershipAfterInvitation(["revoked"])).toBeNull();
  });

  it("admits a Clerk membership when a revoked invitation was superseded by a new one", async () => {
    const membership = await syncMembershipAfterInvitation(["revoked", "pending"]);
    expect(membership?.status).toBe("active");
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
      .prepare(
        `SELECT organization_id
         FROM auth_organization_identities
         WHERE provider = 'clerk' AND provider_org_id = ?`
      )
      .bind("org_clerk_delete_only")
      .first<{ organization_id: string }>();

    expect(missingOrg).toBeNull();

    mockClerkUserLookup("user_clerk_member", "admin@example.com", "verified", [
      {
        role: "org:admin",
        organization: {
          id: "org_clerk_membership",
          name: "Membership Org",
          slug: "membership-org",
        },
      },
    ]);
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
      .prepare(
        `SELECT u.email, om.user_id, om.organization_id, om.role, om.status
         FROM organization_members om
         JOIN users u ON u.id = om.user_id
         JOIN auth_user_identities aui ON aui.user_id = u.id
         WHERE aui.provider = 'clerk' AND aui.provider_user_id = ?`
      )
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

    if (!membership) {
      throw new Error("Expected the Clerk membership to exist");
    }

    const sessionService = new SessionService(getDb(env));
    const elevatedSession = await sessionService.createSession(
      membership.user_id,
      membership.organization_id,
      {}
    );

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
    const elevatedSessionRow = await getDb(env)
      .prepare("SELECT revoked_at FROM sessions WHERE id = ?")
      .bind(elevatedSession.id)
      .first<{ revoked_at: string | null }>();
    expect(elevatedSessionRow?.revoked_at).not.toBeNull();

    const memberSession = await sessionService.createSession(
      membership.user_id,
      membership.organization_id,
      {}
    );

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
      .prepare(
        `SELECT om.status
         FROM organization_members om
         JOIN auth_user_identities aui ON aui.user_id = om.user_id
         WHERE aui.provider = 'clerk' AND aui.provider_user_id = ?`
      )
      .bind("user_clerk_member")
      .first<{ status: string }>();

    expect(removed?.status).toBe("removed");
    const memberSessionRow = await getDb(env)
      .prepare("SELECT revoked_at FROM sessions WHERE id = ?")
      .bind(memberSession.id)
      .first<{ revoked_at: string | null }>();
    expect(memberSessionRow?.revoked_at).not.toBeNull();

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
      .prepare(
        `SELECT om.status
         FROM organization_members om
         JOIN auth_user_identities aui ON aui.user_id = om.user_id
         WHERE aui.provider = 'clerk' AND aui.provider_user_id = ?`
      )
      .bind("user_clerk_member")
      .first<{ status: string }>();
    expect(stillRemoved?.status).toBe("removed");

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
      .prepare(
        `SELECT om.status
         FROM organization_members om
         JOIN auth_user_identities aui ON aui.user_id = om.user_id
         WHERE aui.provider = 'clerk' AND aui.provider_user_id = ?`
      )
      .bind("user_clerk_member")
      .first<{ status: string }>();
    expect(activeAgain?.status).toBe("active");
  });

  it("syncs user lifecycle and Clerk organization deletion", async () => {
    mockClerkUserLookup("user_clerk_lifecycle", "member@example.com");
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
    if (!userId) {
      throw new Error("Expected the Clerk user mapping to exist");
    }

    const organization = await getDb(env)
      .prepare(
        `SELECT organization_id
         FROM auth_organization_identities
         WHERE provider = 'clerk' AND provider_org_id = ?`
      )
      .bind("org_clerk_lifecycle")
      .first<{ organization_id: string }>();
    if (!organization) {
      throw new Error("Expected the Clerk organization mapping to exist");
    }
    const sessionService = new SessionService(getDb(env));
    const userSession = await sessionService.createSession(
      userId,
      organization.organization_id,
      {}
    );

    const apiKeyHash = "webhook_lifecycle_key_hash";
    const lifecycleProject = await getDb(env)
      .prepare(
        `SELECT p.id
         FROM projects p
         JOIN auth_organization_identities aoi ON aoi.organization_id = p.organization_id
         WHERE aoi.provider = 'clerk' AND aoi.provider_org_id = ? AND p.environment = 'sandbox'`
      )
      .bind("org_clerk_lifecycle")
      .first<{ id: string }>();
    if (!lifecycleProject) {
      throw new Error("Expected the Clerk organization sandbox project to exist");
    }
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
      .first<{ status: string }>();

    expect(removedUser?.status).toBe("deleted");
    const userSessionRow = await getDb(env)
      .prepare("SELECT revoked_at FROM sessions WHERE id = ?")
      .bind(userSession.id)
      .first<{ revoked_at: string | null }>();
    expect(userSessionRow?.revoked_at).not.toBeNull();

    const deletedOrg = await simulateClerkWebhook({
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
  const COUNTERPARTY_ID = "cpty_123e4567-e89b-12d3-a456-426614174000";
  const CUSTOMER_REFERENCE = "965a5ef5-77f3-482e-917f-194c30143810";
  const AGREEMENT_SESSION_REFERENCE = "95d360c0-65dd-4598-acc0-89cab6b249da";
  const USER_ID = "usr_bvnk_webhook";
  const WALLET_ID = "a:1:wallet:1";
  const FUNDING_WALLET_ID = "a:funding:wallet:1";
  const walletName = buildBvnkFundingWalletName(`cpa_${COUNTERPARTY_ID}`);

  async function seedVerifiableCounterparty() {
    await getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(ORG_ID, "BVNK Webhook Org", "bvnk-webhook-org", "enterprise", "active")
      .run();
    await getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
      .bind(USER_ID, "webhook-user@example.com", 1, "active")
      .run();
    await seedDefaultProjects(getDb(env), {
      organizationId: ORG_ID,
      createdBy: USER_ID,
      members: [],
      ids: { sandbox: PROJECT_ID, production: `${PROJECT_ID}_production` },
    });
    await getDb(env)
      .prepare(
        `INSERT INTO counterparties (
           id, organization_id, project_id, external_id, entity_type, display_name,
           provider_data, status, created_by
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`
      )
      .bind(COUNTERPARTY_ID, ORG_ID, PROJECT_ID, null, "individual", "Webhook Buyer", {}, null)
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO counterparty_provider_accounts (
           id, organization_id, project_id, counterparty_id, provider,
           provider_customer_reference, kind, metadata
         ) VALUES (?, ?, ?, ?, 'bvnk', ?, 'customer_link', ?)`
      )
      .bind(`cpa_${COUNTERPARTY_ID}`, ORG_ID, PROJECT_ID, COUNTERPARTY_ID, CUSTOMER_REFERENCE, {
        status: "PENDING",
      })
      .run();
  }

  async function sendBvnkWebhook(
    payload: Record<string, unknown>,
    signature?: string,
    environment: "sandbox" | "production" = "sandbox"
  ) {
    const body = JSON.stringify({
      timestamp: new Date().toISOString(),
      ...payload,
    });
    const secret = environment === "production" ? env.BVNK_WEBHOOK_SECRET : BVNK_WEBHOOK_SECRET;
    if (secret === undefined) {
      throw new Error("BVNK webhook secret is not configured for this environment");
    }
    const sig = signature ?? createHmac("sha256", secret).update(body).digest("base64");
    const background: Promise<unknown>[] = [];
    const executionCtx: ExecutionContext = {
      waitUntil(promise) {
        background.push(promise);
      },
      passThroughOnException() {},
      props: {},
    };
    const res = await app.request(
      `/webhooks/payments/ramps/${environment}/bvnk`,
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

  async function seedAgreementSession(): Promise<void> {
    await getDb(env)
      .prepare(
        `UPDATE counterparty_provider_accounts
         SET metadata = ?
         WHERE counterparty_id = ? AND provider = 'bvnk' AND kind = 'customer_link'`
      )
      .bind(
        {
          residenceCountryCode: "US",
          session: {
            reference: AGREEMENT_SESSION_REFERENCE,
            agreements: [],
            consentSubmittedAt: "2026-09-16T17:18:00.000Z",
          },
        },
        COUNTERPARTY_ID
      )
      .run();
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(BVNK_WEBHOOK_TIMESTAMP));
    await seedTestDatabase(env);
    env.BVNK_SANDBOX_WEBHOOK_SECRET = BVNK_WEBHOOK_SECRET;
    env.BVNK_WEBHOOK_SECRET = BVNK_WEBHOOK_SECRET;
    await seedVerifiableCounterparty();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    env.BVNK_SANDBOX_WEBHOOK_SECRET = undefined;
    env.BVNK_WEBHOOK_SECRET = undefined;
  });

  async function readFundingWalletRow(id: string) {
    return getDb(env)
      .prepare("SELECT * FROM counterparty_provider_accounts WHERE id = ?")
      .bind(id)
      .first<{ provider_status: string | null; updated_at: string }>();
  }

  function readCustomerLinkMetadata() {
    return getDb(env)
      .prepare(
        `SELECT metadata FROM counterparty_provider_accounts
         WHERE counterparty_id = ? AND provider = 'bvnk' AND kind = 'customer_link'`
      )
      .bind(COUNTERPARTY_ID)
      .first<{ metadata: Record<string, unknown> }>();
  }

  async function seedFundingWalletRow(input: {
    id: string;
    providerCustomerReference: string;
    externalAccountReference: string | null;
    providerStatus: string;
    projectId?: string;
    counterpartyId?: string;
  }) {
    await getDb(env)
      .prepare(
        `INSERT INTO counterparty_provider_accounts (
           id, organization_id, project_id, counterparty_id, provider,
           provider_customer_reference, kind, fiat_currency,
           external_account_reference, provider_status, metadata
         ) VALUES (?, ?, ?, ?, 'bvnk', ?, 'funding_wallet', 'USD', ?, ?, '{}'::jsonb)`
      )
      .bind(
        input.id,
        ORG_ID,
        input.projectId === undefined ? PROJECT_ID : input.projectId,
        input.counterpartyId === undefined ? COUNTERPARTY_ID : input.counterpartyId,
        input.providerCustomerReference,
        input.externalAccountReference,
        input.providerStatus
      )
      .run();
  }

  const verifiedCustomerStatusEvent = bvnkPlatformCustomerStatusChangeEvent({
    data: { status: "VERIFIED", reference: CUSTOMER_REFERENCE },
  });

  function mockBvnkWalletProvisioning(
    fundingWalletId: string,
    walletName: string,
    createError?: string
  ) {
    const listWallets = vi
      .spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "listLedgerWalletsV2")
      .mockResolvedValue({ content: [], hasNext: false });
    const getProfile = vi
      .spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "listLedgerWalletProfilesV2")
      .mockResolvedValue(
        bvnkWalletProfilesResponse({
          content: [{ id: "profile_webhook_funding_1", currencies: ["USD"], methods: ["ACH"] }],
        })
      );
    const createWallet =
      createError === undefined
        ? vi
            .spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "createLedgerWalletV2")
            .mockResolvedValue(bvnkLedgerWallet({ id: fundingWalletId, name: walletName }))
        : vi
            .spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "createLedgerWalletV2")
            .mockRejectedValue(new Error(createError));
    return { listWallets, getProfile, createWallet };
  }

  async function readLastWebhookEvent(environment: "sandbox" | "production") {
    return getDb(env)
      .prepare(
        `SELECT status, terminal, attempts, last_error FROM ramp_webhook_events
         WHERE provider = 'bvnk' AND environment = ?
         ORDER BY created_at DESC LIMIT 1`
      )
      .bind(environment)
      .first<{ status: string; terminal: boolean; attempts: number; last_error: string | null }>();
  }

  async function expectTerminalWebhookEvent(
    environment: "sandbox" | "production",
    errorFragment: string
  ) {
    const stored = await readLastWebhookEvent(environment);
    expect(stored).toEqual({
      status: "failed",
      terminal: true,
      attempts: RAMP_WEBHOOK_EVENT_MAX_ATTEMPTS,
      last_error: expect.stringContaining(errorFragment),
    });
  }

  async function expectNoBvnkWebhookEvents() {
    const pending = await getDb(env)
      .prepare("SELECT count(*) AS count FROM ramp_webhook_events WHERE provider = 'bvnk'")
      .first<{ count: number }>();
    expect(Number(pending?.count)).toBe(0);
  }

  async function readTransferStatus(id: string) {
    return getDb(env)
      .prepare("SELECT status FROM payment_transfers WHERE id = ?")
      .bind(id)
      .first<{ status: string }>();
  }

  function seedOnrampTransfer(
    id: string,
    status: PaymentTransferStatus,
    counterpartyId: string,
    options: {
      projectId?: string;
      fiatAmount?: string;
      providerData?: Record<string, unknown>;
    } = {}
  ): Promise<void> {
    return seedBvnkOnrampTransfer(getDb(env), {
      id,
      status,
      counterpartyId,
      organizationId: ORG_ID,
      projectId: options.projectId ?? PROJECT_ID,
      fiatAmount: options.fiatAmount ?? "9.9",
      destinationAddress: "dest",
      ...(options.providerData === undefined ? {} : { providerData: options.providerData }),
    });
  }

  function seedFundingRow(
    id: string,
    externalAccountReference: string | null,
    options: { projectId?: string; counterpartyId?: string } = {}
  ): Promise<void> {
    return seedFundingWalletRow({
      id,
      providerCustomerReference: CUSTOMER_REFERENCE,
      externalAccountReference,
      providerStatus: BVNK_FUNDING_WALLET_STATUS.provisioning,
      projectId: options.projectId ?? PROJECT_ID,
      counterpartyId: options.counterpartyId ?? COUNTERPARTY_ID,
    });
  }

  function fundingWalletEvent(id: string, options: { status?: string; customerId?: string } = {}) {
    return bvnkWalletStatusChangeEvent({
      name: buildBvnkFundingWalletName(`cpa_${COUNTERPARTY_ID}`),
      id,
      ...(options.status === undefined ? {} : { status: options.status }),
      customer: { id: options.customerId ?? CUSTOMER_REFERENCE },
    });
  }

  function seedProductionCounterparty(): Promise<string> {
    const productionCounterpartyId = "cpty_123e4567-e89b-12d3-a456-426614174999";
    return getDb(env)
      .prepare(
        `INSERT INTO counterparties (
           id, organization_id, project_id, external_id, entity_type, display_name,
           provider_data, status, created_by
         ) VALUES (?, ?, ?, ?, 'individual', 'Production Webhook Buyer', '{}', 'active', ?)`
      )
      .bind(productionCounterpartyId, ORG_ID, `${PROJECT_ID}_production`, null, USER_ID)
      .run()
      .then(() => productionCounterpartyId);
  }

  async function seedBvnkOfframpTransfer(
    transferId: string,
    options: {
      projectId: string;
      counterpartyId: string;
      providerReference: string;
      channelWalletId: string;
      channelCustomerReference: string;
    }
  ): Promise<void> {
    await getDb(env)
      .prepare(
        `INSERT INTO payment_transfers (
           id, organization_id, project_id, counterparty_id, wallet_id, source_address,
           destination_address, token, amount, memo, type, direction, status, provider,
           provider_reference, delivery_mode, fiat_currency, fiat_amount, provider_data,
           signature, serialized_tx, initiated_by_key_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        transferId,
        ORG_ID,
        options.projectId,
        options.counterpartyId,
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
        // The provider reference is the BVNK channel uuid the quote path stored,
        // unique per channel and therefore per transfer.
        options.providerReference,
        "manual_instructions",
        "USD",
        null,
        // Recorded by the quote completion once, on this transfer — the
        // webhook proves the channel against exactly these facts.
        {
          bvnk: {
            channel: {
              id: options.providerReference,
              walletId: options.channelWalletId,
              customerReference: options.channelCustomerReference,
            },
          },
        },
        null,
        null,
        null,
        "2026-06-28T06:22:15.239Z",
        "2026-06-28T06:22:17.258Z"
      )
      .run();
  }

  it("claims a per-fiat funding wallet row and creates the BVNK USD wallet on VERIFIED", async () => {
    const { createWallet } = mockBvnkWalletProvisioning(FUNDING_WALLET_ID, walletName);

    const res = await sendBvnkWebhook(verifiedCustomerStatusEvent);
    const replay = await sendBvnkWebhook(verifiedCustomerStatusEvent);

    expect(res.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(createWallet).toHaveBeenCalledTimes(1);
    expect(createWallet).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        customerId: CUSTOMER_REFERENCE,
        name: walletName,
        currency: "USD",
        profileId: "profile_webhook_funding_1",
        idempotencyKey: await buildBvnkWalletIdempotencyKey(walletName),
      })
    );
    const account = await readCustomerLinkMetadata();
    expect(account?.metadata.status).toBe("VERIFIED");
    const row = await getDb(env)
      .prepare(
        `SELECT id, organization_id, project_id, counterparty_id, provider,
                provider_customer_reference, kind, external_account_reference,
                fiat_currency, provider_status, status, metadata
         FROM counterparty_provider_accounts
         WHERE counterparty_id = ? AND provider = 'bvnk' AND kind = 'funding_wallet'`
      )
      .bind(COUNTERPARTY_ID)
      .first<Record<string, unknown>>();
    expect(row).toEqual({
      id: expect.stringMatching(/^counterparty_provider_account_/),
      organization_id: ORG_ID,
      project_id: PROJECT_ID,
      counterparty_id: COUNTERPARTY_ID,
      provider: "bvnk",
      provider_customer_reference: CUSTOMER_REFERENCE,
      kind: "funding_wallet",
      external_account_reference: FUNDING_WALLET_ID,
      fiat_currency: "USD",
      provider_status: BVNK_FUNDING_WALLET_STATUS.provisioning,
      status: "active",
      metadata: {},
    });
    const auditActions = await getDb(env)
      .prepare(
        `SELECT metadata::jsonb ->> 'action' AS action FROM audit_logs
         WHERE resource_type = 'counterparty' AND resource_id = ?
           AND metadata::jsonb ->> 'provider' = 'bvnk'
         ORDER BY created_at ASC`
      )
      .bind(COUNTERPARTY_ID)
      .all<{ action: string }>();
    expect(auditActions.results.map((row) => row.action)).toEqual(
      expect.arrayContaining(["bvnk_funding_wallet_created"])
    );
    const active = await getDb(env)
      .prepare(
        `SELECT id FROM counterparty_provider_accounts
         WHERE counterparty_id = ? AND provider = 'bvnk' AND kind = 'funding_wallet' AND status = 'active'`
      )
      .bind(COUNTERPARTY_ID)
      .all<{ id: string }>();
    expect(active.results).toHaveLength(1);
  });

  it("parks a second VERIFIED delivery whose claim has not landed as in flight", async () => {
    const { createWallet } = mockBvnkWalletProvisioning(FUNDING_WALLET_ID, walletName);

    const first = await sendBvnkWebhook(verifiedCustomerStatusEvent);
    await getDb(env)
      .prepare(
        `UPDATE counterparty_provider_accounts
         SET external_account_reference = NULL, updated_at = ?
         WHERE counterparty_id = ? AND provider = 'bvnk' AND kind = 'funding_wallet'`
      )
      .bind(new Date().toISOString(), COUNTERPARTY_ID)
      .run();
    const racing = await sendBvnkWebhook(verifiedCustomerStatusEvent);

    expect(first.status).toBe(200);
    expect(racing.status).toBe(200);
    expect(createWallet).toHaveBeenCalledTimes(1);
    const stored = await readLastWebhookEvent("sandbox");
    expect(stored?.status).toBe("pending");
    expect(stored?.last_error).toContain("in flight");
  });

  it("takes over a stale claimed row and assigns the created wallet", async () => {
    const { createWallet } = mockBvnkWalletProvisioning(FUNDING_WALLET_ID, walletName);
    await seedFundingRow("cpa_bvnk_funding_stale_claim", null);
    await getDb(env)
      .prepare("UPDATE counterparty_provider_accounts SET updated_at = ? WHERE id = ?")
      .bind(
        new Date(Date.now() - BVNK_FUNDING_WALLET_CLAIM_TAKEOVER_MS - 1000).toISOString(),
        "cpa_bvnk_funding_stale_claim"
      )
      .run();

    await sendBvnkWebhook(verifiedCustomerStatusEvent);

    expect(createWallet).toHaveBeenCalledTimes(1);
    const claimed = await getDb(env)
      .prepare(
        `SELECT external_account_reference FROM counterparty_provider_accounts
         WHERE id = 'cpa_bvnk_funding_stale_claim'`
      )
      .first<{ external_account_reference: string | null }>();
    expect(claimed?.external_account_reference).toBe(FUNDING_WALLET_ID);
  });

  it("records a rejected wallet create on the webhook row and keeps the claim unassigned", async () => {
    mockBvnkWalletProvisioning(
      "a:funding:wallet:never",
      "never-created",
      "BVNK funding wallet create failed"
    );

    await sendBvnkWebhook(verifiedCustomerStatusEvent);

    const stored = await readLastWebhookEvent("sandbox");
    expect(stored?.status).toBe("pending");
    expect(stored?.last_error).toContain("BVNK funding wallet create failed");
    const claimed = await getDb(env)
      .prepare(
        `SELECT external_account_reference, provider_status, status
         FROM counterparty_provider_accounts
         WHERE counterparty_id = ? AND provider = 'bvnk' AND kind = 'funding_wallet'`
      )
      .bind(COUNTERPARTY_ID)
      .first<Record<string, unknown>>();
    expect(claimed).toEqual({
      external_account_reference: null,
      provider_status: BVNK_FUNDING_WALLET_STATUS.provisioning,
      status: "active",
    });
  });

  it("provisions a claimed funding row when the ACTIVE wallet status-change arrives", async () => {
    const FUNDING_ROW_ID = "cpa_bvnk_funding_status_active";
    const FUNDING_WALLET_ID = "a:funding:wallet:status:1";
    await seedFundingRow(FUNDING_ROW_ID, FUNDING_WALLET_ID);
    const before = await readFundingWalletRow(FUNDING_ROW_ID);
    assert(before);

    await sendBvnkWebhook(fundingWalletEvent(FUNDING_WALLET_ID));

    const after = await readFundingWalletRow(FUNDING_ROW_ID);
    assert(after);
    expect(after.provider_status).toBe(BVNK_FUNDING_WALLET_STATUS.provisioned);
    expect(after.updated_at).not.toBe(before.updated_at);
    expect({ ...after, updated_at: before.updated_at }).toEqual({
      ...before,
      provider_status: BVNK_FUNDING_WALLET_STATUS.provisioned,
    });
  });

  it("ignores a non-ACTIVE funding wallet status-change", async () => {
    const FUNDING_ROW_ID = "cpa_bvnk_funding_status_inactive";
    const FUNDING_WALLET_ID = "a:funding:wallet:status:3";
    await seedFundingRow(FUNDING_ROW_ID, FUNDING_WALLET_ID);
    const before = await readFundingWalletRow(FUNDING_ROW_ID);

    const res = await sendBvnkWebhook(
      fundingWalletEvent(FUNDING_WALLET_ID, { status: "INACTIVE" })
    );

    expect(res.status).toBe(200);
    expect(await readFundingWalletRow(FUNDING_ROW_ID)).toEqual(before);
  });

  it("parks a customer-mismatched funding wallet event as terminal and leaves the row untouched", async () => {
    const FUNDING_ROW_ID = "cpa_bvnk_funding_status_customer";
    const FUNDING_WALLET_ID = "a:funding:wallet:status:4";
    await seedFundingWalletRow({
      id: FUNDING_ROW_ID,
      providerCustomerReference: CUSTOMER_REFERENCE,
      externalAccountReference: FUNDING_WALLET_ID,
      providerStatus: BVNK_FUNDING_WALLET_STATUS.provisioning,
    });
    const before = await readFundingWalletRow(FUNDING_ROW_ID);

    await sendBvnkWebhook(
      fundingWalletEvent(FUNDING_WALLET_ID, { customerId: "another-customer" })
    );

    // Sandbox terminal errors are deleted by the inbox (R16), so the terminal
    // parking is observed as the event row's absence — a non-terminal error
    // would leave a pending row behind.
    await expectNoBvnkWebhookEvents();
    expect(await readFundingWalletRow(FUNDING_ROW_ID)).toEqual(before);
  });

  it("parks an orphan duplicate wallet event as terminal and leaves the row untouched", async () => {
    const FUNDING_ROW_ID = "cpa_bvnk_funding_status_wallet";
    const FUNDING_WALLET_ID = "a:funding:wallet:status:5";
    await seedFundingWalletRow({
      id: FUNDING_ROW_ID,
      providerCustomerReference: CUSTOMER_REFERENCE,
      externalAccountReference: FUNDING_WALLET_ID,
      providerStatus: BVNK_FUNDING_WALLET_STATUS.provisioning,
    });
    const before = await readFundingWalletRow(FUNDING_ROW_ID);

    await sendBvnkWebhook(fundingWalletEvent("a:funding:wallet:other:1"));

    // Sandbox terminal errors are deleted by the inbox (R16), so the terminal
    // parking is observed as the event row's absence — a non-terminal error
    // would leave a pending row behind.
    await expectNoBvnkWebhookEvents();
    expect(await readFundingWalletRow(FUNDING_ROW_ID)).toEqual(before);
  });

  it("records an unassigned-reference funding wallet event and leaves the row untouched", async () => {
    const FUNDING_ROW_ID = "cpa_bvnk_funding_status_unassigned";
    await seedFundingRow(FUNDING_ROW_ID, null);
    const before = await readFundingWalletRow(FUNDING_ROW_ID);

    await sendBvnkWebhook(fundingWalletEvent("a:funding:wallet:status:6"));

    const stored = await readLastWebhookEvent("sandbox");
    expect(stored?.status).toBe("pending");
    expect(stored?.last_error).toContain("reference is not assigned yet");
    expect(await readFundingWalletRow(FUNDING_ROW_ID)).toEqual(before);
  });

  it("acknowledges a legacy wallet create event for a funding name without writing rows", async () => {
    const res = await sendBvnkWebhook({
      event: "bvnk:ledger:wallet:create",
      data: {
        walletName: buildBvnkFundingWalletName(`cpa_${COUNTERPARTY_ID}`),
        status: "COMPLETED",
        ledgers: [{ accountNumber: "900368997705", code: "101019644" }],
      },
    });

    expect(res.status).toBe(200);
    const fundingRows = await getDb(env)
      .prepare("SELECT id FROM counterparty_provider_accounts WHERE kind = 'funding_wallet'")
      .all<{ id: string }>();
    expect(fundingRows.results).toEqual([]);
    await expectNoBvnkWebhookEvents();
  });

  it("parks a legacy 6-part on-ramp wallet event as terminal without writing rows", async () => {
    await sendBvnkWebhook(
      bvnkWalletStatusChangeEvent({
        name: `sdp:onramp:${COUNTERPARTY_ID}:USD:USDC_SOLANA:dest`,
      }),
      undefined,
      "production"
    );

    await expectTerminalWebhookEvent("production", "SDP no longer manages");
    const row = await getDb(env)
      .prepare("SELECT provider_data FROM counterparties WHERE id = ?")
      .bind(COUNTERPARTY_ID)
      .first<{ provider_data: Record<string, unknown> }>();
    expect(row?.provider_data).toEqual({});
  });

  it("refreshes the customer status when a status-change reports an unverified status", async () => {
    const getCustomer = vi.spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "getCustomer").mockResolvedValue(
      bvnkCustomer({
        reference: CUSTOMER_REFERENCE,
        status: "INFO_REQUIRED",
        verification: { status: "init", url: "https://in.sumsub.com/websdk/p/sbx_test" },
      })
    );

    await sendBvnkWebhook(
      bvnkPlatformCustomerStatusChangeEvent({
        data: { status: "ACTIONS_REQUIRED", reference: CUSTOMER_REFERENCE },
      })
    );

    expect(getCustomer).toHaveBeenCalledWith(expect.anything(), { reference: CUSTOMER_REFERENCE });
    const account = await readCustomerLinkMetadata();
    expect(account?.metadata.status).toBe("INFO_REQUIRED");
    expect(account?.metadata.verificationStatus).toBe("init");
    const bvnk = (
      await getDb(env)
        .prepare("SELECT provider_data FROM counterparties WHERE id = ?")
        .bind(COUNTERPARTY_ID)
        .first<{ provider_data: { bvnk?: { customer?: unknown } } }>()
    )?.provider_data.bvnk;
    expect(bvnk?.customer).toBeUndefined();
  });

  it("resolves a platform:customer:update by external reference and refreshes via the stored reference", async () => {
    const getCustomer = vi.spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "getCustomer").mockResolvedValue(
      bvnkCustomer({
        reference: CUSTOMER_REFERENCE,
        status: "PENDING",
        verification: { status: "pending" },
      })
    );

    await sendBvnkWebhook(bvnkPlatformCustomerUpdateEvent());

    expect(getCustomer).toHaveBeenCalledWith(expect.anything(), { reference: CUSTOMER_REFERENCE });
    const account = await readCustomerLinkMetadata();
    expect(account?.metadata.status).toBe("PENDING");
  });

  it("parks a legacy merchant off-ramp wallet event as terminal without writing rows", async () => {
    const OFFRAMP_WALLET_ID = "a:offramp:wallet:1";
    const before = { bvnk: { offramp: { wallets: { USD: { id: OFFRAMP_WALLET_ID } } } } };
    await getDb(env)
      .prepare("UPDATE counterparties SET provider_data = ? WHERE id = ?")
      .bind(before, COUNTERPARTY_ID)
      .run();

    await sendBvnkWebhook(
      bvnkWalletStatusChangeEvent({
        name: `sdp:offramp:USD:${COUNTERPARTY_ID}`,
      }),
      undefined,
      "production"
    );

    await expectTerminalWebhookEvent("production", "SDP no longer manages");
    const row = await getDb(env)
      .prepare("SELECT provider_data FROM counterparties WHERE id = ?")
      .bind(COUNTERPARTY_ID)
      .first<{ provider_data: Record<string, unknown> }>();
    expect(row?.provider_data).toEqual(before);
  });

  it("settles an awaiting BVNK on-ramp transfer from a v1 COMPLETED pay-in matched by its remittance", async () => {
    const transferId = "xfr_123e4567-e89b-12d3-a456-426614174000";
    const { counterpartyId } = await seedBvnkOnrampCounterpartyAndFundingWallet(getDb(env), {
      organizationId: ORG_ID,
      projectId: PROJECT_ID,
      name: "payin_settles",
      createdBy: USER_ID,
      fundingWalletReference: WALLET_ID,
    });
    await seedOnrampTransfer(transferId, "awaiting_payment", counterpartyId, {
      fiatAmount: "100",
    });

    await sendBvnkWebhook(
      bvnkV1PayinEvent({
        transactionReference: "payin_settles_1",
        paymentReference: "SDP-ONRAMP",
        additionalRemittanceInformation: `xfr_${transferId.slice(4)}`,
        amount: 149.5,
        customerReference: bvnkSeedCustomerReference("payin_settles"),
      })
    );

    const transfer = await getDb(env)
      .prepare(
        "SELECT status, fiat_amount, fiat_currency, provider_data FROM payment_transfers WHERE id = ?"
      )
      .bind(transferId)
      .first<{
        status: string;
        fiat_amount: string | null;
        fiat_currency: string | null;
        provider_data: { bvnk?: { payin?: Record<string, unknown> } };
      }>();
    expect(transfer?.status).toBe("settling");
    expect(transfer?.fiat_amount).toBe("149.5");
    expect(transfer?.fiat_currency).toBe("USD");
    expect(transfer?.provider_data.bvnk?.payin).toEqual({
      id: "payin_settles_1",
      receivedAmount: "149.5",
      receivedCurrency: "USD",
      walletId: WALLET_ID,
      customerId: bvnkSeedCustomerReference("payin_settles"),
    });
    await expectNoBvnkWebhookEvents();
  });

  it("acknowledges a replayed pay-in id with identical immutable facts whatever the transfer status", async () => {
    const transferId = "xfr_123e4567-e89b-12d3-a456-426614174001";
    const payinFacts = {
      id: "payin_replay_1",
      receivedAmount: "149.5",
      receivedCurrency: "USD",
      walletId: WALLET_ID,
      customerId: bvnkSeedCustomerReference("payin_replay"),
    };
    await seedPayinApplied({ name: "payin_replay", transferId, payin: payinFacts });
    const payload = bvnkV1PayinEvent({
      transactionReference: payinFacts.id,
      amount: 149.5,
      walletId: WALLET_ID,
      customerReference: bvnkSeedCustomerReference("payin_replay"),
      paymentReference: "SDP-ONRAMP",
      additionalRemittanceInformation: `xfr_${transferId.slice(4)}`,
    });

    const res = await sendBvnkWebhook(payload);

    expect(res.status).toBe(200);
    const transfer = await getDb(env)
      .prepare("SELECT status, fiat_amount, provider_data FROM payment_transfers WHERE id = ?")
      .bind(transferId)
      .first<{
        status: string;
        fiat_amount: string | null;
        provider_data: { bvnk?: { payin?: Record<string, unknown> } };
      }>();
    expect(transfer?.status).toBe("settling");
    expect(transfer?.fiat_amount).toBe("149.5");
    expect(transfer?.provider_data.bvnk?.payin).toEqual(payinFacts);
    await expectNoBvnkWebhookEvents();
  });

  it("parks a v1 pay-in for an unknown transfer id as terminal", async () => {
    await sendBvnkWebhook(
      bvnkV1PayinEvent({
        transactionReference: "payin_unknown_transfer_1",
        paymentReference: "SDP-ONRAMP xfr_99999999-9999-4999-9999-999999999999",
      }),
      undefined,
      "production"
    );

    await expectTerminalWebhookEvent(
      "production",
      "stray pay-in: unknown transfer or environment mismatch"
    );
  });

  it("parks a duplicate pay-in with changed immutable facts as terminal", async () => {
    const transferId = "xfr_123e4567-e89b-12d3-a456-426614174003";
    await seedPayinApplied({
      name: "payin_conflict",
      transferId,
      projectId: `${PROJECT_ID}_production`,
      payin: {
        id: "payin_conflict_1",
        receivedAmount: "149.5",
        receivedCurrency: "USD",
        walletId: WALLET_ID,
        customerId: bvnkSeedCustomerReference("payin_conflict"),
      },
    });

    await sendBvnkWebhook(
      bvnkV1PayinEvent({
        transactionReference: "payin_conflict_1",
        amount: 300,
        walletId: WALLET_ID,
        customerReference: bvnkSeedCustomerReference("payin_conflict"),
      }),
      undefined,
      "production"
    );

    await expectTerminalWebhookEvent("production", "conflicting pay-in observation");
    expect((await readTransferStatus(transferId))?.status).toBe("settling");
  });

  it("parks a pay-in whose funding wallet binding mismatches as terminal", async () => {
    const productionCounterpartyId = await seedProductionCounterparty();
    const transferId = "xfr_123e4567-e89b-12d3-a456-426614174004";
    await seedOnrampTransfer(transferId, "awaiting_payment", productionCounterpartyId, {
      projectId: `${PROJECT_ID}_production`,
      fiatAmount: "100",
    });
    await seedFundingRow("cpa_bvnk_payin_binding", WALLET_ID, {
      projectId: `${PROJECT_ID}_production`,
      counterpartyId: productionCounterpartyId,
    });

    await sendBvnkWebhook(
      bvnkV1PayinEvent({
        transactionReference: "payin_binding_1",
        walletId: WALLET_ID,
        customerReference: "customer_foreign",
        paymentReference: "SDP-ONRAMP",
        additionalRemittanceInformation: `xfr_${transferId.slice(4)}`,
      }),
      undefined,
      "production"
    );

    await expectTerminalWebhookEvent("production", "funding wallet binding mismatch");
    const transfer = await readTransferStatus(transferId);
    expect(transfer?.status).toBe("awaiting_payment");
  });

  it("parks a pay-in whose transfer lives in another environment as terminal", async () => {
    const transferId = "xfr_123e4567-e89b-12d3-a456-426614174005";
    await seedOnrampTransfer(transferId, "awaiting_payment", COUNTERPARTY_ID, {
      fiatAmount: "100",
    });
    await seedFundingRow("cpa_bvnk_payin_env", WALLET_ID);

    await sendBvnkWebhook(
      bvnkV1PayinEvent({
        transactionReference: "payin_env_mismatch_1",
        paymentReference: "SDP-ONRAMP",
        additionalRemittanceInformation: `xfr_${transferId.slice(4)}`,
      }),
      undefined,
      "production"
    );

    await expectTerminalWebhookEvent("production", "unknown transfer or environment mismatch");
    const transfer = await readTransferStatus(transferId);
    expect(transfer?.status).toBe("awaiting_payment");
  });

  it("acknowledges a v2 pay-in delivery without writing rows", async () => {
    const res = await sendBvnkWebhook(bvnkV2PayinStatusChangeEvent());
    expect(res.status).toBe(200);
    await expectNoBvnkWebhookEvents();
  });

  it("payin_unique_conflict_resolves_original_owner", async () => {
    const ownerTransferId = "xfr_123e4567-e89b-12d3-a456-426614174100";
    const rivalTransferId = "xfr_123e4567-e89b-12d3-a456-426614174101";
    const payinId = "payin_race";
    // The rival row exists first: the ownership lookup must MISS it, the
    // competitor (owner) is committed by the REAL repository in between, and
    // only then does the rival's applyPayin raise the unique constraint.
    const productionCounterpartyId = await seedProductionCounterparty();
    await seedOnrampTransfer(rivalTransferId, "awaiting_payment", productionCounterpartyId, {
      projectId: `${PROJECT_ID}_production`,
      fiatAmount: "100",
    });
    await seedFundingRow("cpa_bvnk_payin_race", WALLET_ID, {
      projectId: `${PROJECT_ID}_production`,
      counterpartyId: productionCounterpartyId,
    });

    const ownerSeed = {
      name: "race_owner",
      transferId: ownerTransferId,
      projectId: `${PROJECT_ID}_production`,
      payin: {
        id: payinId,
        receivedAmount: "100",
        receivedCurrency: "USD",
        walletId: WALLET_ID,
        customerId: CUSTOMER_REFERENCE,
      },
    };
    const originalFactory = repositories.createPostgresBvnkOnrampTransfersRepository;
    const factorySpy = vi.spyOn(repositories, "createPostgresBvnkOnrampTransfersRepository");
    let payinOwnerLookups = 0;
    factorySpy.mockImplementation((db) => {
      const real = originalFactory(db);
      return {
        ...real,
        getByPayinId: async (input) => {
          payinOwnerLookups += 1;
          if (payinOwnerLookups === 1) {
            // The ownership lookup MISSES, and the competitor's row is
            // committed via the real repository between the miss and the
            // rival's applyPayin (which then violates the unique index).
            await seedPayinApplied(ownerSeed);
            return null;
          }
          return real.getByPayinId(input);
        },
      };
    });

    const raceEvent = (amount: number) =>
      bvnkV1PayinEvent({
        transactionReference: payinId,
        amount,
        customerReference: CUSTOMER_REFERENCE,
        paymentReference: `SDP-ONRAMP ${rivalTransferId}`,
      });

    const raced = await sendBvnkWebhook(raceEvent(100), undefined, "production");
    expect(raced.status).toBe(200);
    expect(payinOwnerLookups).toBe(2);
    await expectNoBvnkWebhookEvents();
    const owner = await readTransferStatus(ownerTransferId);
    assert(owner !== null);
    expect(owner.status).toBe("settling");
    expect((await readTransferStatus(rivalTransferId))?.status).toBe("awaiting_payment");

    const conflicting = await sendBvnkWebhook(raceEvent(200), undefined, "production");
    expect(conflicting.status).toBe(200);
    await expectTerminalWebhookEvent("production", "conflicting pay-in observation");
    expect((await readTransferStatus(ownerTransferId))?.status).toBe("settling");
    expect((await readTransferStatus(rivalTransferId))?.status).toBe("awaiting_payment");
    expect(factorySpy).toHaveBeenCalled();
  });

  function seedPayinApplied(input: {
    name: string;
    transferId: string;
    projectId?: string;
    payin: {
      id: string;
      receivedAmount: string;
      receivedCurrency: string;
      walletId: string;
      customerId: string;
    };
  }) {
    return seedBvnkOnrampPayinApplied(getDb(env), {
      organizationId: ORG_ID,
      projectId: input.projectId ?? PROJECT_ID,
      name: input.name,
      createdBy: USER_ID,
      fundingWalletReference: WALLET_ID,
      transferId: input.transferId,
      destinationAddress: "dest",
      payin: input.payin,
    });
  }

  /** The claim-time spend intent these payout events observe: wallet amount 9.9 USD, USDC dest, on Solana. */
  const PAYOUT_INTENT = {
    amount: "9.9",
    currency: "USD",
    cryptoCurrency: "USDC",
    network: "SOLANA",
    address: "dest",
  } as const;

  /**
   * Seeds a settling payout through the SHARED real-transition fixtures:
   * `seedBvnkOnrampPayinApplied` → `seedBvnkOnrampPayoutClaimed` →
   * `seedBvnkOnrampPayoutIssued`, so the payout id and the PROCESSING
   * settlement land exactly like the reconciler writes them. An absent
   * `payoutId` leaves the payout claimed but unissued (the webhook-before-id
   * case).
   */
  function seedPayoutState(input: {
    name: string;
    transferId: string;
    projectId?: string;
    environment?: "sandbox" | "production";
    payoutId?: string;
  }) {
    const scope = {
      organizationId: ORG_ID,
      projectId: input.projectId ?? PROJECT_ID,
      name: input.name,
      createdBy: USER_ID,
      fundingWalletReference: WALLET_ID,
      transferId: input.transferId,
      destinationAddress: "dest",
      payin: {
        id: input.transferId,
        receivedAmount: "9.9",
        receivedCurrency: "USD",
        walletId: WALLET_ID,
        customerId: bvnkSeedCustomerReference(input.name),
      },
      claimedAt: "2026-09-18T00:00:00.000Z",
      intent: PAYOUT_INTENT,
    };
    if (input.payoutId === undefined) {
      return seedBvnkOnrampPayoutClaimed(getDb(env), scope);
    }
    return seedBvnkOnrampPayoutIssued(getDb(env), {
      ...scope,
      environment: input.environment ?? "sandbox",
      payoutId: input.payoutId,
    });
  }

  const OFFRAMP_CHANNEL_BASE = {
    channelId: "019f0ce4-98ab-7424-a968-fc323266b8ed",
    merchantDisplayName: `sdp:offramp:USD:${COUNTERPARTY_ID}`,
    uuid: "019f0ce4-c7c2-7a12-ac86-9f1820ff48e1",
    hash: "3B9neiFe2HG3P8ovttfH1XrppubeFtMcKWZDhw9rzLUqUSQrfLYdzpC3v3ctsbtQBt1rwUPkBaa4SWG2SZzqtXD2",
    address: "H8j6ZdeUt1D3GexMhUs6mSrncK7r4KkspKuLVhpsA7V6",
    paidCurrency: "USDC",
    displayCurrency: "USD",
    walletCurrency: "USD",
    feeCurrency: "USD",
  } as const;

  const bvnkCompletePayoutEvent = (transferId: string, hash: string, uuid = "payout_1") =>
    bvnkCryptoPayoutStatusChangeEvent({
      status: "COMPLETE",
      reference: transferId,
      uuid,
      paidCurrency: { actual: 9.8802, amount: 9.8802, currency: "USDC" },
      walletCurrency: { actual: 9.9, amount: 9.9, currency: "USD" },
      feeCurrency: { actual: 0.1, amount: 0.1, currency: "USD" },
      exchangeRate: { base: "USD", rate: 0.998, counter: "USDC" },
      address: { address: "dest", network: "SOLANA" },
      transactions: [{ hash }],
    });

  it("acknowledges a PROCESSING payout once the settlement is stored", async () => {
    const transferId = "xfr_bvnk_payout_processing";
    const seeded = await seedPayoutState({
      name: "payout_processing",
      transferId,
      payoutId: "payout_1",
    });

    const res = await sendBvnkWebhook(
      bvnkCryptoPayoutStatusChangeEvent({ reference: transferId, uuid: "payout_1" })
    );

    expect(res.status).toBe(200);
    const transfer = await getDb(env)
      .prepare("SELECT status, signature, provider_data FROM payment_transfers WHERE id = ?")
      .bind(transferId)
      .first<{
        status: string;
        signature: string | null;
        provider_data: Record<string, unknown>;
      }>();
    expect(transfer?.status).toBe("settling");
    expect(transfer?.signature).toBeNull();
    expect(transfer?.provider_data.settlement).toEqual(seeded.provider_data.settlement);
  });

  it("throws a non-terminal error when a COMPLETE payout arrives before the payout id is stored", async () => {
    const transferId = "xfr_bvnk_payout_unrecorded";
    const hash =
      "5XGAib9T1PRDQ3sNVofzfP94VUMUh2qqd9BKLBVBQs4Kpnj4JfjaqvAr3Pbx6k8MXA65b6654ooy2TaptkB9iwcM";
    // Claimed but never issued: no payout id is recorded, so the terminal
    // observation cannot be applied and the inbox replay retries.
    await seedPayoutState({ name: "payout_unrecorded", transferId });

    await sendBvnkWebhook(bvnkCompletePayoutEvent(transferId, hash));

    const stored = await readLastWebhookEvent("sandbox");
    expect(stored?.status).toBe("pending");
    expect(stored?.last_error).toContain("payout id was recorded; the inbox replay will retry");
    expect((await readTransferStatus(transferId))?.status).toBe("settling");
  });

  it("settles the transfer from a COMPLETE payout with the conversion economics written", async () => {
    const transferId = "xfr_bvnk_payout_complete";
    const hash =
      "5XGAib9T1PRDQ3sNVofzfP94VUMUh2qqd9BKLBVBQs4Kpnj4JfjaqvAr3Pbx6k8MXA65b6654ooy2TaptkB9iwcM";
    const seeded = await seedPayoutState({
      name: "payout_complete",
      transferId,
      payoutId: "payout_1",
    });

    await sendBvnkWebhook(bvnkCompletePayoutEvent(transferId, hash));

    const transfer = await getDb(env)
      .prepare(
        "SELECT status, fiat_amount, amount, signature, destination_address, provider_data FROM payment_transfers WHERE id = ?"
      )
      .bind(transferId)
      .first<{
        status: string;
        fiat_amount: string | null;
        amount: string | null;
        signature: string | null;
        destination_address: string | null;
        provider_data: { settlement?: unknown };
      }>();
    expect(transfer?.status).toBe("completed");
    expect(transfer?.fiat_amount).toBe("9.9");
    expect(transfer?.amount).toBe("9.8802");
    expect(transfer?.signature).toBe(hash);
    expect(transfer?.destination_address).toBe("dest");
    expect(transfer?.provider_data.settlement).toEqual({
      ...(seeded.provider_data.settlement as Record<string, unknown>),
      status: "COMPLETE",
      txHash: hash,
      cryptoAmountActual: "9.8802",
      fiatAmountActual: "9.9",
      feeAmountActual: "0.1",
      feeCurrencyActual: "USD",
      networkFeeAmountActual: "0",
      networkFeeCurrencyActual: "USD",
      exchangeRateActual: "0.998",
    });
  });

  it("fails the transfer from a FAILED payout without refunding anything", async () => {
    const transferId = "xfr_bvnk_payout_failed";
    await seedPayoutState({ name: "payout_failed", transferId, payoutId: "payout_1" });

    await sendBvnkWebhook(
      bvnkCryptoPayoutStatusChangeEvent({
        status: "FAILED",
        reference: transferId,
        uuid: "payout_1",
        transactions: [],
      })
    );

    const transfer = await getDb(env)
      .prepare("SELECT status, error, provider_data FROM payment_transfers WHERE id = ?")
      .bind(transferId)
      .first<{
        status: string;
        error: string | null;
        provider_data: { bvnk?: { payout?: { payoutId?: string; lastError?: string } } };
      }>();
    expect(transfer?.status).toBe("failed");
    expect(transfer?.error).toBe("FAILED");
    expect(transfer?.provider_data.bvnk?.payout?.payoutId).toBe("payout_1");
    expect(transfer?.provider_data.bvnk?.payout?.lastError).toBe("FAILED");
  });

  it("parks a payout whose payout id differs from the stored one as terminal", async () => {
    const transferId = "xfr_bvnk_payout_other_uuid";
    const hash =
      "5XGAib9T1PRDQ3sNVofzfP94VUMUh2qqd9BKLBVBQs4Kpnj4JfjaqvAr3Pbx6k8MXA65b6654ooy2TaptkB9iwcM";
    await seedPayoutState({
      name: "payout_other_uuid",
      transferId,
      projectId: `${PROJECT_ID}_production`,
      environment: "production",
      payoutId: "payout_1",
    });

    await sendBvnkWebhook(
      bvnkCompletePayoutEvent(transferId, hash, "payout_other"),
      undefined,
      "production"
    );

    await expectTerminalWebhookEvent("production", "stray payout: payout id mismatch");
    expect((await readTransferStatus(transferId))?.status).toBe("settling");
  });

  it("parks a payout whose transfer lives in another environment as terminal", async () => {
    const transferId = "xfr_bvnk_payout_env_mismatch";
    await seedPayoutState({ name: "payout_env_mismatch", transferId, payoutId: "payout_1" });

    await sendBvnkWebhook(
      bvnkCryptoPayoutStatusChangeEvent({ reference: transferId, uuid: "payout_1" }),
      undefined,
      "production"
    );

    await expectTerminalWebhookEvent(
      "production",
      "stray payout: unknown transfer or environment mismatch"
    );
    expect((await readTransferStatus(transferId))?.status).toBe("settling");
  });

  it("ignores pay-in and payout statuses outside the acted-on vocabulary", async () => {
    const payin = await sendBvnkWebhook(
      bvnkV1PayinEvent({ transactionReference: "payin_dispatch_1", status: "REFUNDED" })
    );
    const payout = await sendBvnkWebhook(
      bvnkCryptoPayoutStatusChangeEvent({
        status: "REFUNDED",
        reference: "xfr_bvnk_dispatch_payout",
        uuid: "payout_1",
      })
    );

    expect(payin.status).toBe(200);
    expect(payout.status).toBe(200);
    await expectNoBvnkWebhookEvents();
  });

  it("moves a BVNK off-ramp transfer to settling when a channel transaction is detected", async () => {
    const transferId = "xfr_d7a72b93-cd7e-405b-96b5-73ca368a7bd7";
    const channelId = OFFRAMP_CHANNEL_BASE.channelId;
    await seedBvnkOfframpTransfer(transferId, {
      projectId: PROJECT_ID,
      counterpartyId: COUNTERPARTY_ID,
      providerReference: channelId,
      channelWalletId: FUNDING_WALLET_ID,
      channelCustomerReference: CUSTOMER_REFERENCE,
    });
    const getChannel = vi
      .spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "getChannelV2")
      .mockResolvedValue(matchingOfframpChannel(transferId, channelId));

    await sendBvnkWebhook(
      bvnkChannelTransactionEvent("transaction-detected", {
        ...OFFRAMP_CHANNEL_BASE,
        eventId: "019f0ce4-c81e-7000-8000-000000000000",
        reference: buildBvnkOfframpReference(transferId),
        dateCreated: 1782627747852,
        lastUpdated: 1782627747852,
        status: "DETECTED",
      })
    );

    expect(getChannel).toHaveBeenCalledWith(expect.anything(), { channelId });
    const transfer = await getDb(env)
      .prepare("SELECT status, fiat_amount FROM payment_transfers WHERE id = ?")
      .bind(transferId)
      .first<{ status: string; fiat_amount: string | null }>();
    expect(transfer).toEqual({ status: "settling", fiat_amount: null });

    const productionTransferId = "xfr_d7a72b93-cd7e-405b-96b5-73ca368a7be7";
    await seedBvnkOfframpTransfer(productionTransferId, {
      projectId: `${PROJECT_ID}_production`,
      counterpartyId: COUNTERPARTY_ID,
      providerReference: channelId,
      channelWalletId: FUNDING_WALLET_ID,
      channelCustomerReference: CUSTOMER_REFERENCE,
    });
    const mismatched = await sendBvnkWebhook(
      bvnkChannelTransactionEvent("transaction-detected", {
        ...OFFRAMP_CHANNEL_BASE,
        eventId: "019f0ce4-c81e-7000-8000-000000000001",
        reference: buildBvnkOfframpReference(productionTransferId),
      })
    );
    expect(mismatched.status).toBe(200);
    expect((await readTransferStatus(productionTransferId))?.status).toBe("awaiting_payment");
    await expectNoBvnkWebhookEvents();
  });

  /** A BVNK channel read-back matching the transfer's own recorded channel facts. */
  function matchingOfframpChannel(transferId: string, channelId: string) {
    return {
      uuid: channelId,
      walletId: FUNDING_WALLET_ID,
      reference: buildBvnkOfframpReference(transferId),
      status: "OPEN",
      payCurrency: "USDC",
      displayCurrency: "USD",
      walletCurrency: "USD",
      address: OFFRAMP_CHANNEL_BASE.address,
      protocol: "SOL",
      network: "SOLANA",
      contact: {
        id: "33fa1b49-12bb-46ea-ad2c-40034fcdb91d",
        externalId: COUNTERPARTY_ID,
        relationshipType: "THIRD_PARTY",
        entityType: "INDIVIDUAL",
      },
      embeddedCustomerDetails: { reference: CUSTOMER_REFERENCE },
    } as const;
  }

  it("completes a BVNK off-ramp transfer from a confirmed channel transaction", async () => {
    const transferId = "xfr_d7a72b93-cd7e-405b-96b5-73ca368a7bd7";
    const channelId = OFFRAMP_CHANNEL_BASE.channelId;
    await seedBvnkOfframpTransfer(transferId, {
      projectId: PROJECT_ID,
      counterpartyId: COUNTERPARTY_ID,
      providerReference: channelId,
      channelWalletId: FUNDING_WALLET_ID,
      channelCustomerReference: CUSTOMER_REFERENCE,
    });
    const getChannel = vi
      .spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "getChannelV2")
      .mockResolvedValue(matchingOfframpChannel(transferId, channelId));

    await sendBvnkWebhook(
      bvnkChannelTransactionEvent("transaction-confirmed", {
        ...OFFRAMP_CHANNEL_BASE,
        eventId: "019f0ce5-28a6-7000-8000-000000000000",
        reference: buildBvnkOfframpReference(transferId),
        dateCreated: 1782627748000,
        lastUpdated: 1782627771174,
        status: "COMPLETE",
        paidAmount: 5,
        displayAmount: 4.95,
        walletAmount: 4.95,
        feeAmount: 0.04,
        sources: [
          "GSDYH3kHc4iAVHSCrTxxhXLsoQfMLo6eYLPbA3HLgvzg",
          "6zZcSMwGfY7iPkNvBtZksmNr9JCgg9Q1CGDRjtV4f2U9",
        ],
      })
    );

    expect(getChannel).toHaveBeenCalledWith(expect.anything(), { channelId });
    const transfer = await getDb(env)
      .prepare("SELECT status, fiat_amount FROM payment_transfers WHERE id = ?")
      .bind(transferId)
      .first<{ status: string; fiat_amount: string | null }>();
    expect(transfer).toEqual({ status: "completed", fiat_amount: "4.95" });
  });

  it("parks a confirmed BVNK channel transaction whose read-back names a different wallet as terminal", async () => {
    const transferId = "xfr_d7a72b93-cd7e-405b-96b5-73ca368a7bc7";
    const channelId = "019f0ce5-28a6-7000-8000-000000000011";
    await seedBvnkOfframpTransfer(transferId, {
      projectId: PROJECT_ID,
      counterpartyId: COUNTERPARTY_ID,
      providerReference: channelId,
      channelWalletId: FUNDING_WALLET_ID,
      channelCustomerReference: CUSTOMER_REFERENCE,
    });
    vi.spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "getChannelV2").mockResolvedValue({
      ...matchingOfframpChannel(transferId, channelId),
      walletId: "a:other:wallet:1",
    });

    await sendBvnkWebhook(
      bvnkChannelTransactionEvent("transaction-confirmed", {
        ...OFFRAMP_CHANNEL_BASE,
        eventId: "019f0ce5-28a6-7000-8000-000000000012",
        reference: buildBvnkOfframpReference(transferId),
        walletAmount: 4.95,
      })
    );

    expect((await readTransferStatus(transferId))?.status).toBe("awaiting_payment");
    await expectNoBvnkWebhookEvents();
  });

  it("parks a confirmed BVNK channel transaction whose read-back names a different customer as terminal", async () => {
    const transferId = "xfr_d7a72b93-cd7e-405b-96b5-73ca368a7bf7";
    const channelId = "019f0ce5-28a6-7000-8000-000000000021";
    await seedBvnkOfframpTransfer(transferId, {
      projectId: PROJECT_ID,
      counterpartyId: COUNTERPARTY_ID,
      providerReference: channelId,
      channelWalletId: FUNDING_WALLET_ID,
      channelCustomerReference: CUSTOMER_REFERENCE,
    });
    vi.spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "getChannelV2").mockResolvedValue({
      ...matchingOfframpChannel(transferId, channelId),
      embeddedCustomerDetails: { reference: "11111111-2222-3333-4444-555555555555" },
    });

    await sendBvnkWebhook(
      bvnkChannelTransactionEvent("transaction-confirmed", {
        ...OFFRAMP_CHANNEL_BASE,
        eventId: "019f0ce5-28a6-7000-8000-000000000022",
        reference: buildBvnkOfframpReference(transferId),
        walletAmount: 4.95,
      })
    );

    expect((await readTransferStatus(transferId))?.status).toBe("awaiting_payment");
    await expectNoBvnkWebhookEvents();
  });

  it("retries a confirmed BVNK channel transaction when the channel read-back fails", async () => {
    const transferId = "xfr_d7a72b93-cd7e-405b-96b5-73ca368a8bd7";
    const channelId = "019f0ce5-28a6-7000-8000-000000000031";
    await seedBvnkOfframpTransfer(transferId, {
      projectId: PROJECT_ID,
      counterpartyId: COUNTERPARTY_ID,
      providerReference: channelId,
      channelWalletId: FUNDING_WALLET_ID,
      channelCustomerReference: CUSTOMER_REFERENCE,
    });
    vi.spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "getChannelV2").mockRejectedValue(
      new Error("BVNK channel read failed")
    );

    await sendBvnkWebhook(
      bvnkChannelTransactionEvent("transaction-confirmed", {
        ...OFFRAMP_CHANNEL_BASE,
        eventId: "019f0ce5-28a6-7000-8000-000000000032",
        reference: buildBvnkOfframpReference(transferId),
        walletAmount: 4.95,
      })
    );

    const stored = await readLastWebhookEvent("sandbox");
    expect(stored?.status).toBe("pending");
    expect(stored?.attempts).toBe(1);
    expect(stored?.last_error).toContain("BVNK channel read failed");
    expect((await readTransferStatus(transferId))?.status).toBe("awaiting_payment");
  });

  it("parks a confirmed BVNK channel transaction whose read-back reference names another transfer as terminal", async () => {
    const transferId = "xfr_d7a72b93-cd7e-405b-96b5-73ca368a8bd1";
    const channelId = "019f0ce5-28a6-7000-8000-000000000041";
    const counterpartyId = await seedProductionCounterparty();
    await seedBvnkOfframpTransfer(transferId, {
      projectId: `${PROJECT_ID}_production`,
      counterpartyId,
      providerReference: channelId,
      channelWalletId: FUNDING_WALLET_ID,
      channelCustomerReference: CUSTOMER_REFERENCE,
    });
    vi.spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "getChannelV2").mockResolvedValue({
      ...matchingOfframpChannel(transferId, channelId),
      reference: buildBvnkOfframpReference("xfr_d7a72b93-cd7e-405b-96b5-73ca368a8c01"),
    });

    await sendBvnkWebhook(
      bvnkChannelTransactionEvent("transaction-confirmed", {
        ...OFFRAMP_CHANNEL_BASE,
        eventId: "019f0ce5-28a6-7000-8000-000000000042",
        reference: buildBvnkOfframpReference(transferId),
        walletAmount: 4.95,
      }),
      undefined,
      "production"
    );

    await expectTerminalWebhookEvent("production", "channel reference mismatch");
    expect((await readTransferStatus(transferId))?.status).toBe("awaiting_payment");
  });

  it("parks a confirmed BVNK channel transaction whose read-back carries no embedded customer as terminal", async () => {
    const transferId = "xfr_d7a72b93-cd7e-405b-96b5-73ca368a8bd2";
    const channelId = "019f0ce5-28a6-7000-8000-000000000043";
    const counterpartyId = await seedProductionCounterparty();
    await seedBvnkOfframpTransfer(transferId, {
      projectId: `${PROJECT_ID}_production`,
      counterpartyId,
      providerReference: channelId,
      channelWalletId: FUNDING_WALLET_ID,
      channelCustomerReference: CUSTOMER_REFERENCE,
    });
    const { embeddedCustomerDetails: _absent, ...channel } = matchingOfframpChannel(
      transferId,
      channelId
    );
    vi.spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "getChannelV2").mockResolvedValue(channel);

    await sendBvnkWebhook(
      bvnkChannelTransactionEvent("transaction-confirmed", {
        ...OFFRAMP_CHANNEL_BASE,
        eventId: "019f0ce5-28a6-7000-8000-000000000044",
        reference: buildBvnkOfframpReference(transferId),
        walletAmount: 4.95,
      }),
      undefined,
      "production"
    );

    await expectTerminalWebhookEvent("production", "channel customer mismatch");
    expect((await readTransferStatus(transferId))?.status).toBe("awaiting_payment");
  });

  it("parks a confirmed BVNK channel transaction whose transfer has a null channel reference as terminal", async () => {
    const transferId = "xfr_d7a72b93-cd7e-405b-96b5-73ca368a8bd3";
    const channelId = "019f0ce5-28a6-7000-8000-000000000045";
    const counterpartyId = await seedProductionCounterparty();
    await seedBvnkOfframpTransfer(transferId, {
      projectId: `${PROJECT_ID}_production`,
      counterpartyId,
      providerReference: channelId,
      channelWalletId: FUNDING_WALLET_ID,
      channelCustomerReference: CUSTOMER_REFERENCE,
    });
    await getDb(env)
      .prepare("UPDATE payment_transfers SET provider_reference = NULL WHERE id = ?")
      .bind(transferId)
      .run();
    const getChannel = vi.spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "getChannelV2");

    await sendBvnkWebhook(
      bvnkChannelTransactionEvent("transaction-confirmed", {
        ...OFFRAMP_CHANNEL_BASE,
        eventId: "019f0ce5-28a6-7000-8000-000000000046",
        reference: buildBvnkOfframpReference(transferId),
        walletAmount: 4.95,
      }),
      undefined,
      "production"
    );

    await expectTerminalWebhookEvent("production", "transfer has no recorded channel");
    expect(getChannel).not.toHaveBeenCalled();
    expect((await readTransferStatus(transferId))?.status).toBe("awaiting_payment");
  });

  it("parks a confirmed BVNK channel transaction whose provider_data.bvnk has no channel as terminal", async () => {
    const transferId = "xfr_d7a72b93-cd7e-405b-96b5-73ca368a8bd4";
    const channelId = "019f0ce5-28a6-7000-8000-000000000047";
    await seedBvnkOfframpTransfer(transferId, {
      projectId: PROJECT_ID,
      counterpartyId: COUNTERPARTY_ID,
      providerReference: channelId,
      channelWalletId: FUNDING_WALLET_ID,
      channelCustomerReference: CUSTOMER_REFERENCE,
    });
    await getDb(env)
      .prepare("UPDATE payment_transfers SET provider_data = ?::jsonb WHERE id = ?")
      .bind({ bvnk: {} }, transferId)
      .run();
    const getChannel = vi.spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "getChannelV2");

    await sendBvnkWebhook(
      bvnkChannelTransactionEvent("transaction-confirmed", {
        ...OFFRAMP_CHANNEL_BASE,
        eventId: "019f0ce5-28a6-7000-8000-000000000048",
        reference: buildBvnkOfframpReference(transferId),
        walletAmount: 4.95,
      })
    );

    await expectNoBvnkWebhookEvents();
    expect(getChannel).not.toHaveBeenCalled();
    expect((await readTransferStatus(transferId))?.status).toBe("awaiting_payment");
  });

  it("rejects a webhook with an invalid signature", async () => {
    const res = await sendBvnkWebhook(
      { event: "customer.updated", data: { reference: CUSTOMER_REFERENCE, status: "VERIFIED" } },
      "not-a-valid-signature"
    );
    expect(res.status).toBe(401);
  });

  it("records a SIGNED agreement session and advances its stored requirements", async () => {
    await seedAgreementSession();
    const event = bvnkAgreementSessionStatusChangeEvent();

    await sendBvnkWebhook(event);

    const row = await readCustomerLinkMetadata();
    const metadata = row?.metadata as BvnkCustomerProviderAccountMetadata | undefined;
    if (metadata === undefined || metadata.session === undefined) {
      throw new Error("Expected BVNK agreement-session metadata");
    }
    expect(metadata.session.signedAt).toBe(new Date(event.timestamp).toISOString());
    expect(bvnkCustomerLinkProviderStatus(metadata)).toBe("AGREEMENT_SIGNED");
    expect(bvnkCustomerRequirementsFromMetadata("onramp", metadata)).toMatchObject({
      status: "collect_counterparty",
    });
  });

  it("parks a SIGNED agreement session webhook with an unknown reference as terminal", async () => {
    const event = bvnkAgreementSessionStatusChangeEvent({
      data: { status: "SIGNED", reference: "unknown-agreement-session" },
    });
    await sendBvnkWebhook(event);

    // Sandbox terminal errors are deleted by the inbox (R16), so the terminal
    // parking is observed as the event row's absence — a non-terminal error
    // would leave a pending row behind.
    await expectNoBvnkWebhookEvents();
  });

  it("acknowledges a non-SIGNED agreement session without changing the row", async () => {
    await seedAgreementSession();

    const res = await sendBvnkWebhook(
      bvnkAgreementSessionStatusChangeEvent({
        data: { status: "PENDING", reference: AGREEMENT_SESSION_REFERENCE },
      })
    );

    expect(res.status).toBe(200);
    const row = await readCustomerLinkMetadata();
    const metadata = row?.metadata as BvnkCustomerProviderAccountMetadata | undefined;
    if (metadata === undefined || metadata.session === undefined) {
      throw new Error("Expected BVNK agreement-session metadata");
    }
    expect(metadata.session.signedAt).toBeUndefined();
  });

  it("rejects a bvnk webhook that omits the envelope timestamp", async () => {
    const body = JSON.stringify({ ...verifiedCustomerStatusEvent, timestamp: undefined });
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
    platformCustomerId: "cpty_8eac0e73-775a-419c-a2c0-6310ee4d1a78",
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
    await seedDefaultProjects(getDb(env), {
      organizationId: ORG_ID,
      createdBy: USER_ID,
      members: [],
      ids: { sandbox: PROJECT_ID, production: `${PROJECT_ID}_production` },
    });
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
  const TRANSFER_ID = "xfr_moonpay_webhook";
  const MOONPAY_TRANSACTION_ID = "0a5bb889-9afb-4b8d-835b-9b9855d67509";
  const MOONPAY_WEBHOOK_KEY = "moonpay_test_webhook_key";
  const COUNTERPARTY_ID = "cpty_moonpay_webhook";
  const MOONPAY_CUSTOMER_ID = "6e9fd8db-98e4-46f4-bd6e-6a3c30fdda19";

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
    await seedDefaultProjects(getDb(env), {
      organizationId: ORG_ID,
      createdBy: USER_ID,
      members: [],
      ids: { sandbox: PROJECT_ID, production: `${PROJECT_ID}_production` },
    });
    await getDb(env)
      .prepare(
        `INSERT INTO counterparties (
           id, organization_id, project_id, entity_type, display_name, status, created_by
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(COUNTERPARTY_ID, ORG_ID, PROJECT_ID, "individual", "MoonPay Buyer", "active", USER_ID)
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_transfers (
           id, organization_id, project_id, wallet_id, counterparty_id, source_address,
           destination_address, token, amount, memo, type, direction, status, provider,
           provider_reference, delivery_mode, fiat_currency, fiat_amount, provider_data,
           signature, serialized_tx, initiated_by_key_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        TRANSFER_ID,
        ORG_ID,
        PROJECT_ID,
        "wallet_moonpay_webhook",
        COUNTERPARTY_ID,
        null,
        "DestinationSolanaWallet111111111111111111111111",
        "SOL",
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
      .prepare(
        `SELECT status, amount, destination_address, signature, provider_reference, provider_data
         FROM payment_transfers WHERE id = ?`
      )
      .bind(TRANSFER_ID)
      .first<{
        status: string;
        amount: string | null;
        destination_address: string | null;
        signature: string | null;
        provider_reference: string | null;
        provider_data: { settlement?: Record<string, unknown> };
      }>();
    expect(transfer?.status).toBe("completed");
    expect(transfer?.amount).toBe("0.649");
    expect(transfer?.provider_reference).toBe(MOONPAY_TRANSACTION_ID);
    expect(transfer?.destination_address).toBe("WebhookDestinationSolanaWallet111111111111111111");
    expect(transfer?.signature).toBe("t11paHKpm79qTHVgSQ4rr9PAqE7ZT87MWpi1f5Nim8XzPyc7aPux");
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

  it("records a completed sell deposit on the correlated SDP transfer", async () => {
    const sourceAddress = "WebhookSourceSolanaWallet111111111111111111111";
    const destinationAddress = "WebhookMoonPayDepositWallet1111111111111111111";
    const providerSignature =
      "4gYf6JwRXvV9LhJqR6CjvhgpqpNrp41cYwHC1PJNBJdk6FHaaBxTkZQHUnwNi1trGf31FyHg6pQJfUmK4D3kVQnG";
    const submittedSignature =
      "5XGAib9T1PRDQ3sNVofzfP94VUMUh2qqd9BKLBVBQs4Kpnj4JfjaqvAr3Pbx6k8MXA65b6654ooy2TaptkB9iwcM";
    const moonpayTransactionId = "cca8ef45-4aac-4a91-851a-02ff991eeef9";
    await getDb(env)
      .prepare(
        `UPDATE payment_transfers
         SET type = 'offramp', direction = 'outbound', source_address = ?,
             destination_address = NULL, amount = '0.2', fiat_amount = NULL, signature = ?
         WHERE id = ?`
      )
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
      },
    });
    expect(res.status).toBe(200);

    const transfer = await getDb(env)
      .prepare(
        `SELECT status, amount, fiat_amount, source_address, destination_address,
                signature, provider_reference
         FROM payment_transfers WHERE id = ?`
      )
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
      .prepare(
        `SELECT id, counterparty_id, provider, provider_customer_reference, status
         FROM counterparty_provider_accounts
         WHERE counterparty_id = ? AND provider = 'moonpay'`
      )
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
      .prepare(
        `SELECT id FROM counterparty_provider_accounts
         WHERE counterparty_id = ? AND provider = 'moonpay'`
      )
      .bind(COUNTERPARTY_ID)
      .all<{ id: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0].id).toBe(link?.id);
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

  it("refuses an oversized body before verifying its signature", async () => {
    // The handler buffers the whole body to check the HMAC, so an unbounded
    // body is unauthenticated work on this instance's memory. 413 rather than
    // the 401 an unsigned request would otherwise get proves the refusal
    // happens before the handler is reached.
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
