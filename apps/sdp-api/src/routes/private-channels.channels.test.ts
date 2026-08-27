import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey, PrivateChannelDto } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const TEST_ORG = { id: "org_pc_test", name: "Private Channels Test Org", slug: "pc-test-org" };
const TEST_PROJECT = { id: "prj_pc_test", slug: "pc-test-project" };
const TEST_USER = { id: "usr_pc_test", email: "pc-test@example.com" };
const TEST_API_KEY = { id: "key_pc_test", raw: "sk_test_private_channels", prefix: "sk_test_pc" };
const TEST_INSTANCE_ID = "pci_pc_test";

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
        "PC Test Key",
        TEST_API_KEY.prefix,
        keyHash,
        "api_admin",
        JSON.stringify(["*"]),
        "active"
      ),
    getDb(env)
      .prepare(
        `INSERT INTO private_channel_instances
           (id, organization_id, project_id, gateway_url,
            escrow_program_id, withdraw_program_id, escrow_instance_addr, auth_url, is_active)
         VALUES (?, ?, ?, 'http://gw', 'prog1', 'prog2', 'escrow1', 'http://auth', true)`
      )
      .bind(TEST_INSTANCE_ID, TEST_ORG.id, TEST_PROJECT.id),
    // Connecting an instance auto-provisions its default channel (instance connect →
    // getOrCreateDefault). We seed the instance via raw SQL, so mirror that here.
    getDb(env)
      .prepare(
        `INSERT INTO private_channels
           (id, organization_id, project_id, instance_id, name, is_default)
         VALUES (?, ?, ?, ?, 'Default', true)`
      )
      .bind("pch_pc_test_default", TEST_ORG.id, TEST_PROJECT.id, TEST_INSTANCE_ID),
  ]);
}

function authHeaders() {
  return { Authorization: `Bearer ${TEST_API_KEY.raw}`, "Content-Type": "application/json" };
}

describe("Private Channels — channel routes", () => {
  beforeEach(async () => {
    originalEnabled = env.PRIVATE_CHANNELS_ENABLED;
    env.PRIVATE_CHANNELS_ENABLED = "true";
    await seedTestDatabase(env);
    await seedAuth();
  });

  afterEach(async () => {
    env.PRIVATE_CHANNELS_ENABLED = originalEnabled;
    await clearKVStores(env);
  });

  it("returns 403 when the feature is disabled", async () => {
    env.PRIVATE_CHANNELS_ENABLED = undefined;
    const res = await app.request("/v1/private-channels/channels", { headers: authHeaders() }, env);
    expect(res.status).toBe(403);
  });

  it("returns 503 when no active instance is connected", async () => {
    await getDb(env).prepare("DELETE FROM private_channel_instances").run();
    const res = await app.request("/v1/private-channels/channels", { headers: authHeaders() }, env);
    expect(res.status).toBe(503);
  });

  it("GET /channels returns the default channel", async () => {
    const res = await app.request("/v1/private-channels/channels", { headers: authHeaders() }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { channels: PrivateChannelDto[] } };
    expect(body.data.channels).toHaveLength(1);
    expect(body.data.channels[0].isDefault).toBe(true);
  });

  it("POST /channels creates a channel; duplicate name → 409", async () => {
    const create = await app.request(
      "/v1/private-channels/channels",
      { method: "POST", headers: authHeaders(), body: JSON.stringify({ name: "Treasury" }) },
      env
    );
    expect(create.status).toBe(201);
    const created = (await create.json()) as { data: PrivateChannelDto };
    expect(created.data.id).toMatch(/^pch_/);
    expect(created.data.isDefault).toBe(false);

    const dup = await app.request(
      "/v1/private-channels/channels",
      { method: "POST", headers: authHeaders(), body: JSON.stringify({ name: "Treasury" }) },
      env
    );
    expect(dup.status).toBe(409);
  });

  it("rejects an empty channel name with 400", async () => {
    const res = await app.request(
      "/v1/private-channels/channels",
      { method: "POST", headers: authHeaders(), body: JSON.stringify({ name: "   " }) },
      env
    );
    expect(res.status).toBe(400);
  });

  it("DELETE removes a named channel (204) but refuses the default (409)", async () => {
    const create = await app.request(
      "/v1/private-channels/channels",
      { method: "POST", headers: authHeaders(), body: JSON.stringify({ name: "Ops" }) },
      env
    );
    const created = (await create.json()) as { data: PrivateChannelDto };

    const del = await app.request(
      `/v1/private-channels/channels/${created.data.id}`,
      { method: "DELETE", headers: authHeaders() },
      env
    );
    expect(del.status).toBe(204);

    // The default channel is provisioned at instance-connect time (seeded above);
    // fetch it via the list to get its id.
    const list = await app.request(
      "/v1/private-channels/channels",
      { headers: authHeaders() },
      env
    );
    const listed = (await list.json()) as { data: { channels: PrivateChannelDto[] } };
    const def = listed.data.channels.find((c) => c.isDefault);
    expect(def).toBeDefined();

    const delDefault = await app.request(
      `/v1/private-channels/channels/${def?.id}`,
      { method: "DELETE", headers: authHeaders() },
      env
    );
    expect(delDefault.status).toBe(409);
  });

  it("requires auth (401 without a key)", async () => {
    const res = await app.request("/v1/private-channels/channels", {}, env);
    expect(res.status).toBe(401);
  });
});
