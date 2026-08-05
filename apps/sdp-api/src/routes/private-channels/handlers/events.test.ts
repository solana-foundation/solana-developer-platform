import {
  type CachedSession,
  PRIVATE_CHANNEL_EVENT_FAMILIES,
  PRIVATE_CHANNEL_EVENT_STATUSES,
  PRIVATE_CHANNEL_EVENT_TYPES,
  type PrivateChannelEventListEnvelope,
} from "@sdp/types";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { createPostgresPrivateChannelEventRepository } from "@/db/repositories/private-channel-event.repository.postgres";
import { createPostgresPrivateChannelVerifiedWalletRepository } from "@/db/repositories/private-channel-verified-wallet.repository.postgres";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import type { Env } from "@/types/env";
import { listChannelEvents, listProjectEvents } from "./events";

const ORGANIZATION_ID = "org_event_handler_test";
const PROJECT_ID = "prj_event_handler_test";
const USER_ID = "usr_event_handler_test";
const NON_MEMBER_USER_ID = "usr_event_handler_non_member";
const PRIVATE_CHANNEL_USER_ID = "pcu_event_handler_test";
const INSTANCE_ID = "pci_event_handler_test";
const CHANNEL_ID = "pch_event_handler_test";
const VERIFIED_WALLET = "wallet-a";
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
           (id, organization_id, project_id, gateway_url, chain_rpc_url,
            escrow_program_id, withdraw_program_id, escrow_instance_addr, auth_url, is_active)
         VALUES (?, ?, ?, 'http://gw', 'http://rpc', 'prog1', 'prog2', 'escrow1', 'http://auth', true)`
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
        `INSERT INTO private_channel_users (id, organization_id, project_id, user_id)
         VALUES (?, ?, ?, ?)`
      )
      .bind(PRIVATE_CHANNEL_USER_ID, ORGANIZATION_ID, PROJECT_ID, USER_ID)
      .run();

    await createPostgresPrivateChannelVerifiedWalletRepository(db).upsert({
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      userId: PRIVATE_CHANNEL_USER_ID,
      instanceId: INSTANCE_ID,
      walletId: "wallet-id-a",
      pubkey: VERIFIED_WALLET,
    });

    const eventRepository = createPostgresPrivateChannelEventRepository(db);
    await eventRepository.insert({
      id: "pce_member_match",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      instanceId: INSTANCE_ID,
      channelId: CHANNEL_ID,
      sdpUserId: USER_ID,
      family: PRIVATE_CHANNEL_EVENT_FAMILIES.TRANSFER,
      type: PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_TRANSFER_CONFIRMED,
      status: PRIVATE_CHANNEL_EVENT_STATUSES.CONFIRMED,
      payload: { amount: "12.50", signature: "sig_private" },
      wallets: [VERIFIED_WALLET],
      occurredAt: NOW,
      createdAt: NOW,
    });
    await eventRepository.insert({
      id: "pce_other_wallet",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      instanceId: INSTANCE_ID,
      channelId: CHANNEL_ID,
      sdpUserId: null,
      family: PRIVATE_CHANNEL_EVENT_FAMILIES.TRANSFER,
      type: PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_TRANSFER_CONFIRMED,
      status: PRIVATE_CHANNEL_EVENT_STATUSES.CONFIRMED,
      payload: {},
      wallets: ["wallet-b"],
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
      wallets: [],
      occurredAt: NOW,
      createdAt: NOW,
    });
  });

  afterEach(async () => {
    await clearTestDatabase(env);
  });

  it("filters project and channel feeds to a member's verified wallets", async () => {
    const app = buildApp(USER_ID);

    for (const path of ["/events", `/channels/${CHANNEL_ID}/events`]) {
      const res = await app.request(path, {}, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: PrivateChannelEventListEnvelope };
      expect(body.data.events.map((event) => event.id)).toEqual(["pce_member_match"]);
      expect(body.data.events[0]?.wallets).toEqual([VERIFIED_WALLET]);
      expect(body.data.events[0]?.payload).toEqual({});
    }
  });

  it("returns raw payloads only to organization admins", async () => {
    const app = buildApp(USER_ID, ["payments:read", "org:admin"]);

    const res = await app.request("/events", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: PrivateChannelEventListEnvelope };
    const event = body.data.events.find((candidate) => candidate.id === "pce_member_match");

    expect(event?.payload).toEqual({ amount: "12.50", signature: "sig_private" });
  });

  it("returns an empty envelope when the authenticated user has no PC user", async () => {
    const app = buildApp(NON_MEMBER_USER_ID);

    for (const path of ["/events", `/channels/${CHANNEL_ID}/events`]) {
      const res = await app.request(path, {}, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: PrivateChannelEventListEnvelope };
      expect(body.data).toEqual({ events: [], hasMore: false, nextCursor: null });
    }
  });
});
