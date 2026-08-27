import { hashString } from "@sdp/payments/hash";
import * as privateChannelsPkg from "@sdp/private-channels";
import { SANDBOX_DEFAULTS } from "@sdp/private-channels";
import {
  type CachedApiKey,
  PRIVATE_CHANNEL_EVENT_FAMILIES,
  PRIVATE_CHANNEL_EVENT_STATUSES,
  PRIVATE_CHANNEL_EVENT_TYPES,
  type PrivateChannelDto,
  type PrivateChannelEventListEnvelope,
} from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import * as pcServices from "@/services/private-channels";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const probeConnectionMock = vi.spyOn(privateChannelsPkg, "probeConnection");
const overviewMock = vi.spyOn(pcServices, "getInstanceOverview");

function unreachableOverview(error = "gateway down") {
  return {
    gateway: {
      health: { status: "unreachable" as const, latencyMs: 12, error },
      channelSlot: null,
      latestBlockhash: null,
    },
    chainRpc: { ok: false as const, error: "n/a" },
    escrowInstance: { present: false as const, error: "n/a" },
    escrowProgram: { present: false as const, error: "n/a" },
    auth: { reachable: false as const, error: "n/a" },
  };
}

const TEST_ORG = { id: "org_pce_test", name: "PC Events Test Org", slug: "pc-events-test-org" };
const TEST_PROJECT = { id: "prj_pce_test", slug: "pc-events-test-project" };
const TEST_USER = { id: "usr_pce_test", email: "pc-events-test@example.com" };
const TEST_API_KEY = { id: "key_pce_test", raw: "sk_test_pc_events", prefix: "sk_test_pce" };

const TEST_CACHED_API_KEY: CachedApiKey = {
  id: TEST_API_KEY.id,
  organizationId: TEST_ORG.id,
  projectId: TEST_PROJECT.id,
  role: "api_admin",
  permissions: ["*"],
  environment: "sandbox",
  rateLimitTier: "standard",
  allowedIps: null,
  signingWalletId: null,
  status: "active",
  expiresAt: null,
};

let originalEnabled: string | undefined;

function successProbe() {
  return {
    ok: true as const,
    gateway: {
      status: "ready" as const,
      latencyMs: 1,
      health: { status: 200, ok: true },
      ready: { status: 200, ok: true },
    },
    rpc: { ok: true as const, latencyMs: 1, version: "2.0.0" },
    auth: { ok: true as const, latencyMs: 1 },
  };
}

async function seedAuth(): Promise<void> {
  const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, keyHash, TEST_CACHED_API_KEY);
  await getDb(env).batch([
    getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, "enterprise", "active"),
    getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
      .bind(TEST_USER.id, TEST_USER.email, 1, "active"),
    getDb(env)
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        TEST_PROJECT.id,
        TEST_ORG.id,
        "Test Project",
        TEST_PROJECT.slug,
        "sandbox",
        "active",
        TEST_USER.id
      ),
    getDb(env)
      .prepare(
        `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        TEST_API_KEY.id,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_USER.id,
        "PC Events Test Key",
        TEST_API_KEY.prefix,
        keyHash,
        "api_admin",
        JSON.stringify(["*"]),
        "active"
      ),
  ]);
}

function authHeaders() {
  return { Authorization: `Bearer ${TEST_API_KEY.raw}`, "Content-Type": "application/json" };
}

async function connectInstance(): Promise<void> {
  probeConnectionMock.mockResolvedValueOnce(successProbe());
  const res = await app.request(
    "/v1/private-channels/instance",
    {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        gatewayUrl: SANDBOX_DEFAULTS.gatewayUrl,
        escrowProgramId: SANDBOX_DEFAULTS.escrowProgramId,
        withdrawProgramId: SANDBOX_DEFAULTS.withdrawProgramId,
        escrowInstanceAddr: SANDBOX_DEFAULTS.escrowInstanceAddr,
        authUrl: SANDBOX_DEFAULTS.authUrl,
      }),
    },
    env
  );
  expect(res.status).toBe(200);
}

async function defaultChannelId(): Promise<string> {
  const list = await app.request("/v1/private-channels/channels", { headers: authHeaders() }, env);
  const body = (await list.json()) as { data: { channels: PrivateChannelDto[] } };
  const def = body.data.channels.find((c) => c.isDefault);
  expect(def).toBeDefined();
  return def?.id ?? "";
}

describe("Private Channels — event routes", () => {
  beforeEach(async () => {
    originalEnabled = env.PRIVATE_CHANNELS_ENABLED;
    env.PRIVATE_CHANNELS_ENABLED = "true";
    probeConnectionMock.mockReset();
    overviewMock.mockReset();
    await seedTestDatabase(env);
    await seedAuth();
  });

  afterEach(async () => {
    env.PRIVATE_CHANNELS_ENABLED = originalEnabled;
    await clearKVStores(env);
  });

  it("connect emits lifecycle.instance.connected visible on the default channel feed", async () => {
    await connectInstance();
    const channelId = await defaultChannelId();

    const res = await app.request(
      `/v1/private-channels/channels/${channelId}/events`,
      { headers: authHeaders() },
      env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: PrivateChannelEventListEnvelope };
    expect(
      body.data.events.some(
        (e) => e.type === PRIVATE_CHANNEL_EVENT_TYPES.LIFECYCLE_INSTANCE_CONNECTED
      )
    ).toBe(true);
  });

  it("create channel emits lifecycle.channel.created", async () => {
    await connectInstance();
    const create = await app.request(
      "/v1/private-channels/channels",
      { method: "POST", headers: authHeaders(), body: JSON.stringify({ name: "Treasury" }) },
      env
    );
    const created = (await create.json()) as { data: PrivateChannelDto };

    const res = await app.request(
      `/v1/private-channels/channels/${created.data.id}/events?family=${PRIVATE_CHANNEL_EVENT_FAMILIES.LIFECYCLE}&type=${PRIVATE_CHANNEL_EVENT_TYPES.LIFECYCLE_CHANNEL_CREATED}`,
      { headers: authHeaders() },
      env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: PrivateChannelEventListEnvelope };
    expect(body.data.events).toHaveLength(1);
    expect(body.data.events[0]?.type).toBe(PRIVATE_CHANNEL_EVENT_TYPES.LIFECYCLE_CHANNEL_CREATED);
    expect(body.data.events[0]?.channelId).toBe(created.data.id);
    expect(body.data.events[0]?.payload).toEqual({ name: "Treasury" });
  });

  it("filters events by exact status and rejects unknown statuses", async () => {
    await connectInstance();
    const channelId = await defaultChannelId();
    const instance = await getDb(env)
      .prepare(
        "SELECT id, organization_id, project_id FROM private_channel_instances WHERE is_active = true LIMIT 1"
      )
      .first<{ id: string; organization_id: string; project_id: string }>();
    expect(instance).toBeTruthy();

    await getDb(env)
      .prepare(
        `INSERT INTO private_channel_events
           (id, organization_id, project_id, instance_id, channel_id, family, type, status, payload, occurred_at)
         VALUES ('pce_failed_status', ?, ?, ?, ?, ?, ?, ?, '{}'::jsonb, '2026-07-30T12:00:00.000Z')`
      )
      .bind(
        instance?.organization_id,
        instance?.project_id,
        instance?.id,
        channelId,
        PRIVATE_CHANNEL_EVENT_FAMILIES.ERROR,
        PRIVATE_CHANNEL_EVENT_TYPES.ERROR_SPC_UNREACHABLE,
        PRIVATE_CHANNEL_EVENT_STATUSES.FAILED
      )
      .run();

    const filtered = await app.request(
      `/v1/private-channels/channels/${channelId}/events?status=${PRIVATE_CHANNEL_EVENT_STATUSES.FAILED}`,
      { headers: authHeaders() },
      env
    );
    expect(filtered.status).toBe(200);
    const body = (await filtered.json()) as { data: PrivateChannelEventListEnvelope };
    expect(body.data.events.map((event) => event.id)).toEqual(["pce_failed_status"]);

    const invalid = await app.request(
      `/v1/private-channels/channels/${channelId}/events?status=unknown`,
      { headers: authHeaders() },
      env
    );
    expect(invalid.status).toBe(400);
  });

  it("paginates with before cursor", async () => {
    await connectInstance();
    const create = await app.request(
      "/v1/private-channels/channels",
      { method: "POST", headers: authHeaders(), body: JSON.stringify({ name: "Ops" }) },
      env
    );
    const created = (await create.json()) as { data: PrivateChannelDto };
    const channelId = created.data.id;

    // Seed extra events with known timestamps for deterministic pagination.
    const db = getDb(env);
    const instance = await db
      .prepare(
        "SELECT id, organization_id, project_id FROM private_channel_instances WHERE is_active = true LIMIT 1"
      )
      .first<{ id: string; organization_id: string; project_id: string }>();
    expect(instance).toBeTruthy();

    const archived = PRIVATE_CHANNEL_EVENT_TYPES.LIFECYCLE_CHANNEL_ARCHIVED;
    const lifecycle = PRIVATE_CHANNEL_EVENT_FAMILIES.LIFECYCLE;
    const info = PRIVATE_CHANNEL_EVENT_STATUSES.INFO;
    await db
      .prepare(
        `INSERT INTO private_channel_events
           (id, organization_id, project_id, instance_id, channel_id, family, type, status, payload, occurred_at)
         VALUES ('pce_old', ?, ?, ?, ?, ?, ?, ?, '{}'::jsonb, '2026-01-01T00:00:00.000Z')`
      )
      .bind(
        instance?.organization_id,
        instance?.project_id,
        instance?.id,
        channelId,
        lifecycle,
        archived,
        info
      )
      .run();
    await db
      .prepare(
        `INSERT INTO private_channel_events
           (id, organization_id, project_id, instance_id, channel_id, family, type, status, payload, occurred_at)
         VALUES ('pce_new', ?, ?, ?, ?, ?, ?, ?, '{}'::jsonb, '2026-06-01T00:00:00.000Z')`
      )
      .bind(
        instance?.organization_id,
        instance?.project_id,
        instance?.id,
        channelId,
        lifecycle,
        archived,
        info
      )
      .run();

    const page1 = await app.request(
      `/v1/private-channels/channels/${channelId}/events?type=${archived}&limit=1`,
      { headers: authHeaders() },
      env
    );
    const body1 = (await page1.json()) as { data: PrivateChannelEventListEnvelope };
    expect(body1.data.events[0]?.id).toBe("pce_new");
    expect(body1.data.hasMore).toBe(true);
    expect(body1.data.nextCursor).toBeTruthy();

    const page2 = await app.request(
      `/v1/private-channels/channels/${channelId}/events?type=${archived}&limit=1&before=${encodeURIComponent(body1.data.nextCursor ?? "")}`,
      { headers: authHeaders() },
      env
    );
    const body2 = (await page2.json()) as { data: PrivateChannelEventListEnvelope };
    expect(body2.data.events[0]?.id).toBe("pce_old");
    expect(body2.data.hasMore).toBe(false);
    expect(body2.data.nextCursor).toBeNull();
  });

  it("returns 404 for an unknown channel", async () => {
    await connectInstance();
    const res = await app.request(
      "/v1/private-channels/channels/pch_missing/events",
      { headers: authHeaders() },
      env
    );
    expect(res.status).toBe(404);
  });

  it("returns 503 when no active instance", async () => {
    const res = await app.request(
      "/v1/private-channels/channels/pch_anything/events",
      { headers: authHeaders() },
      env
    );
    expect(res.status).toBe(503);
  });

  it("overview emits error.spc_unreachable when the gateway is unreachable", async () => {
    await connectInstance();
    const channelId = await defaultChannelId();
    overviewMock.mockResolvedValue(unreachableOverview("boom"));

    const ov = await app.request(
      "/v1/private-channels/instance/overview",
      { headers: authHeaders() },
      env
    );
    expect(ov.status).toBe(200);

    const res = await app.request(
      `/v1/private-channels/channels/${channelId}/events?family=${PRIVATE_CHANNEL_EVENT_FAMILIES.ERROR}`,
      { headers: authHeaders() },
      env
    );
    const body = (await res.json()) as { data: PrivateChannelEventListEnvelope };
    const err = body.data.events.find(
      (e) => e.type === PRIVATE_CHANNEL_EVENT_TYPES.ERROR_SPC_UNREACHABLE
    );
    expect(err).toBeDefined();
    expect(err?.family).toBe(PRIVATE_CHANNEL_EVENT_FAMILIES.ERROR);
    expect(err?.status).toBe(PRIVATE_CHANNEL_EVENT_STATUSES.FAILED);
    expect(err?.channelId).toBeNull();
    expect(err?.payload).toMatchObject({
      message: "boom",
      gatewayUrl: SANDBOX_DEFAULTS.gatewayUrl,
      latencyMs: 12,
    });
  });

  it("wallet verification events keep the verified pubkey in the payload", async () => {
    const pubkey = "So11111111111111111111111111111111111111112";
    const verifyMock = vi.spyOn(pcServices, "verifyPrivateChannelWallet").mockResolvedValueOnce({
      row: {
        id: "pcvw_event_test",
        wallet_id: "wallet_event_test",
        pubkey,
        verified_at: "2026-07-30T12:00:00.000Z",
      },
      instance: {
        id: "pci_wallet_event_test",
        organization_id: TEST_ORG.id,
        project_id: TEST_PROJECT.id,
      },
    } as never);

    let res: Response;
    try {
      res = await app.request(
        "/v1/private-channels/wallets/wallet_event_test/verify",
        { method: "POST", headers: authHeaders() },
        env
      );
    } finally {
      verifyMock.mockRestore();
    }

    expect(res.status).toBe(200);
    const event = await getDb(env)
      .prepare("SELECT payload FROM private_channel_events WHERE type = ?")
      .bind(PRIVATE_CHANNEL_EVENT_TYPES.MEMBER_WALLET_VERIFIED)
      .first<{ payload: { walletId: string; pubkey: string } }>();
    expect(event?.payload).toEqual({ walletId: "wallet_event_test", pubkey });
  });

  it("wallet revocation events keep the revoked pubkey in the payload", async () => {
    const pubkey = "So11111111111111111111111111111111111111113";
    const deleteMock = vi.spyOn(pcServices, "deletePrivateChannelWallet").mockResolvedValueOnce({
      instance: {
        id: "pci_wallet_event_test",
        organization_id: TEST_ORG.id,
        project_id: TEST_PROJECT.id,
      },
      deleted: true,
    } as never);

    let res: Response;
    try {
      res = await app.request(
        `/v1/private-channels/wallets/${pubkey}`,
        { method: "DELETE", headers: authHeaders() },
        env
      );
    } finally {
      deleteMock.mockRestore();
    }

    expect(res.status).toBe(200);
    const event = await getDb(env)
      .prepare("SELECT payload FROM private_channel_events WHERE type = ?")
      .bind(PRIVATE_CHANNEL_EVENT_TYPES.MEMBER_WALLET_VERIFICATION_REVOKED)
      .first<{ payload: { pubkey: string } }>();
    expect(event?.payload).toEqual({ pubkey });
  });

  it("does not emit a wallet revocation event when no verification was deleted", async () => {
    const pubkey = "So11111111111111111111111111111111111111114";
    const deleteMock = vi.spyOn(pcServices, "deletePrivateChannelWallet").mockResolvedValueOnce({
      instance: {
        id: "pci_wallet_event_test",
        organization_id: TEST_ORG.id,
        project_id: TEST_PROJECT.id,
      },
      deleted: false,
    } as never);

    let res: Response;
    try {
      res = await app.request(
        `/v1/private-channels/wallets/${pubkey}`,
        { method: "DELETE", headers: authHeaders() },
        env
      );
    } finally {
      deleteMock.mockRestore();
    }

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { deleted: false } });
    const event = await getDb(env)
      .prepare("SELECT id FROM private_channel_events WHERE type = ?")
      .bind(PRIVATE_CHANNEL_EVENT_TYPES.MEMBER_WALLET_VERIFICATION_REVOKED)
      .first<{ id: string }>();
    expect(event).toBeNull();
  });

  it("lists project-scoped events across channels", async () => {
    await connectInstance();
    const create = await app.request(
      "/v1/private-channels/channels",
      { method: "POST", headers: authHeaders(), body: JSON.stringify({ name: "Treasury" }) },
      env
    );
    expect(create.status).toBe(201);

    const res = await app.request("/v1/private-channels/events", { headers: authHeaders() }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: PrivateChannelEventListEnvelope };
    const types = body.data.events.map((e) => e.type);
    expect(types).toContain(PRIVATE_CHANNEL_EVENT_TYPES.LIFECYCLE_INSTANCE_CONNECTED);
    expect(types).toContain(PRIVATE_CHANNEL_EVENT_TYPES.LIFECYCLE_CHANNEL_CREATED);
  });

  it("project feed survives instance deletion (durable history)", async () => {
    await connectInstance();
    const del = await app.request(
      "/v1/private-channels/instance",
      { method: "DELETE", headers: authHeaders() },
      env
    );
    expect(del.status).toBe(200);

    const res = await app.request("/v1/private-channels/events", { headers: authHeaders() }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: PrivateChannelEventListEnvelope };
    expect(
      body.data.events.some(
        (e) => e.type === PRIVATE_CHANNEL_EVENT_TYPES.LIFECYCLE_INSTANCE_CONNECTED
      )
    ).toBe(true);
  });
});
