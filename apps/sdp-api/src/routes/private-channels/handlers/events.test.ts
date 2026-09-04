import {
  type CachedSession,
  PRIVATE_CHANNEL_EVENT_FAMILIES,
  PRIVATE_CHANNEL_EVENT_STATUSES,
  PRIVATE_CHANNEL_EVENT_TYPES,
  type PrivateChannelEventListEnvelope,
} from "@sdp/types";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { createPostgresPrivateChannelEventRepository } from "@/db/repositories/private-channel-event.repository.postgres";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import type { Env } from "@/types/env";
import { listChannelEvents, listProjectEvents } from "./events";

const ORGANIZATION_ID = "org_event_handler_test";
const PROJECT_ID = "prj_event_handler_test";
const USER_ID = "usr_event_handler_test";
const NON_MEMBER_USER_ID = "usr_event_handler_non_member";
const PRIVATE_CHANNEL_USER_ID = "pcu_event_handler_test";
const INSTANCE_ID = "pci_event_handler_test";
const CHANNEL_ID = "pch_event_handler_test";
const OTHER_CHANNEL_ID = "pch_event_handler_other";
const NOW = "2026-07-30T12:00:00.000Z";

function buildApp(userId: string, permissions: CachedSession["permissions"] = ["payments:read"]) {
  const app = new Hono<{ Bindings: Env }>();
  const session: CachedSession = {
    id: `ses_${userId}`,
    userId,
    organizationId: ORGANIZATION_ID,
    permissions,
    expiresAt: "2099-01-01T00:00:00.000Z",
  };

  app.use("*", async (c, next) => {
    c.set("session", session);
    c.set("projectId", PROJECT_ID);
    await next();
  });
  app.get("/events", listProjectEvents);
  app.get("/channels/:id/events", listChannelEvents);
  return app;
}

function buildApiKeyApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", async (c, next) => {
    c.set("apiKey", {
      id: "key_event_handler_test",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      role: "api_admin",
      permissions: ["*"],
      environment: "sandbox",
      signingWalletId: null,
    });
    c.set("projectId", PROJECT_ID);
    await next();
  });
  app.get("/events", listProjectEvents);
  return app;
}

describe("Private Channels event handlers", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    const db = getDb(env);

    await db
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, 'Events Org', 'events-org', 'enterprise', 'active')"
      )
      .bind(ORGANIZATION_ID)
      .run();
    for (const [id, email] of [
      [USER_ID, "member@example.com"],
      [NON_MEMBER_USER_ID, "non-member@example.com"],
    ]) {
      await db
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
        .bind(id, email)
        .run();
    }
    await db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Events Project', 'events-project', 'sandbox', 'active', ?)`
      )
      .bind(PROJECT_ID, ORGANIZATION_ID, USER_ID)
      .run();
    await db
      .prepare(
        `INSERT INTO private_channel_instances
           (id, organization_id, project_id, gateway_url,
            escrow_program_id, withdraw_program_id, escrow_instance_addr, auth_url, is_active)
         VALUES (?, ?, ?, 'http://gw', 'prog1', 'prog2', 'escrow1', 'http://auth', true)`
      )
      .bind(INSTANCE_ID, ORGANIZATION_ID, PROJECT_ID)
      .run();
    await db
      .prepare(
        `INSERT INTO private_channels
           (id, organization_id, project_id, instance_id, name, is_default, status)
         VALUES (?, ?, ?, ?, 'Default', true, 'active')`
      )
      .bind(CHANNEL_ID, ORGANIZATION_ID, PROJECT_ID, INSTANCE_ID)
      .run();
    await db
      .prepare(
        `INSERT INTO private_channels
           (id, organization_id, project_id, instance_id, name, is_default, status)
         VALUES (?, ?, ?, ?, 'Other', false, 'active')`
      )
      .bind(OTHER_CHANNEL_ID, ORGANIZATION_ID, PROJECT_ID, INSTANCE_ID)
      .run();
    await db
      .prepare(
        `INSERT INTO private_channel_users
           (id, organization_id, project_id, user_id, instance_id, name, is_default,
            spc_user_id, spc_username, spc_credential_ciphertext)
         VALUES (?, ?, ?, ?, ?, 'Default', true, 'spc_event_handler', 'default', 'encrypted')`
      )
      .bind(PRIVATE_CHANNEL_USER_ID, ORGANIZATION_ID, PROJECT_ID, USER_ID, INSTANCE_ID)
      .run();
    await db
      .prepare(
        `INSERT INTO private_channel_memberships
           (id, channel_id, private_channel_user_id, added_by)
         VALUES ('pcm_event_handler_test', ?, ?, ?)`
      )
      .bind(CHANNEL_ID, PRIVATE_CHANNEL_USER_ID, USER_ID)
      .run();

    const eventRepository = createPostgresPrivateChannelEventRepository(db);
    await eventRepository.insert({
      id: "pce_member_match",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      instanceId: INSTANCE_ID,
      channelId: CHANNEL_ID,
      sdpUserId: USER_ID,
      family: PRIVATE_CHANNEL_EVENT_FAMILIES.LIFECYCLE,
      type: PRIVATE_CHANNEL_EVENT_TYPES.LIFECYCLE_CHANNEL_CREATED,
      status: PRIVATE_CHANNEL_EVENT_STATUSES.INFO,
      payload: { amount: "12.50", signature: "sig_private", adminOnly: "secret-value" },
      occurredAt: NOW,
      createdAt: NOW,
    });
    await eventRepository.insert({
      id: "pce_other_wallet",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      instanceId: INSTANCE_ID,
      channelId: OTHER_CHANNEL_ID,
      sdpUserId: null,
      family: PRIVATE_CHANNEL_EVENT_FAMILIES.TRANSFER,
      type: PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_TRANSFER_CONFIRMED,
      status: PRIVATE_CHANNEL_EVENT_STATUSES.CONFIRMED,
      payload: {},
      occurredAt: NOW,
      createdAt: NOW,
    });
    await eventRepository.insert({
      id: "pce_own_transfer",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      instanceId: INSTANCE_ID,
      channelId: null,
      sdpUserId: USER_ID,
      family: PRIVATE_CHANNEL_EVENT_FAMILIES.TRANSFER,
      type: PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_TRANSFER_SUBMITTED,
      status: PRIVATE_CHANNEL_EVENT_STATUSES.PENDING,
      payload: { senderWalletId: "wallet-id-a", sender: "wallet-a", recipient: "wallet-b" },
      occurredAt: NOW,
      createdAt: NOW,
    });
    await eventRepository.insert({
      id: "pce_other_wallet_event",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      instanceId: INSTANCE_ID,
      channelId: null,
      sdpUserId: "usr_other_member",
      family: PRIVATE_CHANNEL_EVENT_FAMILIES.MEMBER,
      type: PRIVATE_CHANNEL_EVENT_TYPES.MEMBER_WALLET_VERIFIED,
      status: PRIVATE_CHANNEL_EVENT_STATUSES.INFO,
      payload: { pubkey: "other-member-pubkey", walletId: "wallet-other" },
      occurredAt: NOW,
      createdAt: NOW,
    });
    await eventRepository.insert({
      id: "pce_admin_lifecycle",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      instanceId: INSTANCE_ID,
      channelId: null,
      sdpUserId: null,
      family: PRIVATE_CHANNEL_EVENT_FAMILIES.LIFECYCLE,
      type: PRIVATE_CHANNEL_EVENT_TYPES.LIFECYCLE_INSTANCE_CONNECTED,
      status: PRIVATE_CHANNEL_EVENT_STATUSES.INFO,
      payload: {},
      occurredAt: NOW,
      createdAt: NOW,
    });
  });

  it("shows channel memberships plus authored transfers in the project feed", async () => {
    const app = buildApp(USER_ID);

    const projectResponse = await app.request("/events", {}, env);
    expect(projectResponse.status).toBe(200);
    const projectBody = (await projectResponse.json()) as {
      data: PrivateChannelEventListEnvelope;
    };
    expect(projectBody.data.events.map((event) => event.id).sort()).toEqual(
      ["pce_member_match", "pce_own_transfer", "pce_admin_lifecycle"].sort()
    );
    expect(
      projectBody.data.events.find((event) => event.id === "pce_member_match")?.payload
    ).toEqual({
      amount: "12.50",
      signature: "sig_private",
    });
    expect(
      projectBody.data.events.find((event) => event.id === "pce_own_transfer")?.payload
    ).toEqual({
      senderWalletId: "wallet-id-a",
      sender: "wallet-a",
      recipient: "wallet-b",
    });

    const channelResponse = await app.request(`/channels/${CHANNEL_ID}/events`, {}, env);
    expect(channelResponse.status).toBe(200);
    const channelBody = (await channelResponse.json()) as {
      data: PrivateChannelEventListEnvelope;
    };
    expect(channelBody.data.events.map((event) => event.id)).toEqual([
      "pce_member_match",
      "pce_admin_lifecycle",
    ]);
  });

  it("returns raw payloads only to organization admins", async () => {
    const app = buildApp(USER_ID, ["payments:read", "projects:write", "org:admin"]);

    const res = await app.request("/events", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: PrivateChannelEventListEnvelope };
    const event = body.data.events.find((candidate) => candidate.id === "pce_member_match");

    expect(event?.payload).toEqual({
      amount: "12.50",
      signature: "sig_private",
      adminOnly: "secret-value",
    });
  });

  it("hides another member's channel-less events from both feeds", async () => {
    const app = buildApp(USER_ID);

    for (const path of ["/events", `/channels/${CHANNEL_ID}/events`]) {
      const res = await app.request(path, {}, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: PrivateChannelEventListEnvelope };
      expect(body.data.events.map((event) => event.id)).not.toContain("pce_other_wallet_event");
    }
  });

  it("returns an empty channel feed when the member does not belong to that channel", async () => {
    const res = await buildApp(USER_ID).request(`/channels/${OTHER_CHANNEL_ID}/events`, {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: PrivateChannelEventListEnvelope };
    expect(body.data).toEqual({ events: [], hasMore: false, nextCursor: null });
  });

  it("returns only display-safe payload fields to wildcard API keys", async () => {
    const res = await buildApiKeyApp().request("/events", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: PrivateChannelEventListEnvelope };
    expect(body.data.events.find((event) => event.id === "pce_member_match")?.payload).toEqual({
      amount: "12.50",
      signature: "sig_private",
    });
  });

  it("uses the project's default identity when the actor has no legacy PC user", async () => {
    const app = buildApp(NON_MEMBER_USER_ID);

    for (const path of ["/events", `/channels/${CHANNEL_ID}/events`]) {
      const res = await app.request(path, {}, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: PrivateChannelEventListEnvelope };
      expect(body.data.events.map((event) => event.id).sort()).toEqual(
        ["pce_member_match", "pce_admin_lifecycle"].sort()
      );
      expect(body.data.hasMore).toBe(false);
      expect(body.data.nextCursor).toBeNull();
    }
  });
});
