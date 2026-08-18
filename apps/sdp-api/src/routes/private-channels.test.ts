import { hashString } from "@sdp/payments/hash";
import * as privateChannelsPkg from "@sdp/private-channels";
import { SANDBOX_DEFAULTS } from "@sdp/private-channels";
import type { CachedApiKey, PrivateChannelInstanceEnvelope } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const probeConnectionMock = vi.spyOn(privateChannelsPkg, "probeConnection");

const TEST_ORG = {
  id: "org_pc_test",
  name: "Private Channels Test Org",
  slug: "private-channels-test-org",
};
const TEST_PROJECT = {
  id: "prj_pc_test",
  slug: "private-channels-test-project",
};
const TEST_USER = {
  id: "usr_pc_test",
  email: "private-channels-test@example.com",
};
const TEST_API_KEY = {
  id: "key_pc_test",
  raw: "sk_test_private_channels",
  prefix: "sk_test_pc",
};
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

let originalPrivateChannelsEnabled: string | undefined;

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
        "Private Channels Test Key",
        TEST_API_KEY.prefix,
        keyHash,
        "api_admin",
        JSON.stringify(["*"]),
        "active"
      ),
  ]);
}

function authHeaders() {
  return {
    Authorization: `Bearer ${TEST_API_KEY.raw}`,
    "Content-Type": "application/json",
  };
}

function successProbe() {
  return {
    ok: true,
    gateway: {
      status: "ready" as const,
      latencyMs: 42,
      health: { status: 200, ok: true, body: { status: "ok" } },
      ready: { status: 200, ok: true, body: { status: "ready" } },
    },
    rpc: {
      ok: true as const,
      latencyMs: 33,
      version: "1.18.4",
    },
    auth: {
      ok: true as const,
      latencyMs: 15,
    },
  };
}

describe("Private Channels routes", () => {
  beforeEach(async () => {
    originalPrivateChannelsEnabled = env.PRIVATE_CHANNELS_ENABLED;
    env.PRIVATE_CHANNELS_ENABLED = "true";
    probeConnectionMock.mockReset();
    await seedTestDatabase(env);
    await seedAuth();
  });

  afterEach(async () => {
    env.PRIVATE_CHANNELS_ENABLED = originalPrivateChannelsEnabled;
    await clearKVStores(env);
  });

  it("returns 403 when the feature flag is off", async () => {
    env.PRIVATE_CHANNELS_ENABLED = undefined;
    const res = await app.request("/v1/private-channels/instance", { headers: authHeaders() }, env);
    expect(res.status).toBe(403);
  });

  it("GET /instance returns { instance: null } when no row exists", async () => {
    const res = await app.request("/v1/private-channels/instance", { headers: authHeaders() }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: PrivateChannelInstanceEnvelope };
    expect(body.data.instance).toBeNull();
  });

  it("POST /instance persists the row and returns it when both probes pass", async () => {
    probeConnectionMock.mockResolvedValueOnce(successProbe());

    const res = await app.request(
      "/v1/private-channels/instance",
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(SANDBOX_DEFAULTS),
      },
      env
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: { instance: unknown } };
    const instance = body.data.instance as {
      id: string;
      organizationId: string;
      projectId: string;
      gatewayUrl: string;
      authUrl: string;
      isActive: boolean;
    };
    expect(instance.id).toMatch(/^pci_/);
    expect(instance.organizationId).toBe(TEST_ORG.id);
    expect(instance.projectId).toBe(TEST_PROJECT.id);
    expect(instance.gatewayUrl).toBe(SANDBOX_DEFAULTS.gatewayUrl);
    expect(instance.authUrl).toBe(SANDBOX_DEFAULTS.authUrl);
    expect(instance.isActive).toBe(true);

    const getRes = await app.request(
      "/v1/private-channels/instance",
      { headers: authHeaders() },
      env
    );
    const getBody = (await getRes.json()) as { data: PrivateChannelInstanceEnvelope };
    expect(getBody.data.instance?.id).toBe(instance.id);
    expect(getBody.data.instance?.isActive).toBe(true);
  });

  it("POST /instance returns 409 when an active instance already exists", async () => {
    probeConnectionMock.mockResolvedValueOnce(successProbe());
    const first = await app.request(
      "/v1/private-channels/instance",
      { method: "POST", headers: authHeaders(), body: JSON.stringify(SANDBOX_DEFAULTS) },
      env
    );
    expect(first.status).toBe(200);

    const res = await app.request(
      "/v1/private-channels/instance",
      { method: "POST", headers: authHeaders(), body: JSON.stringify(SANDBOX_DEFAULTS) },
      env
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { details?: { activeInstance?: { id?: string } } };
    };
    expect(body.error.details?.activeInstance?.id).toMatch(/^pci_/);
    // The re-probe path shouldn't have been reached: the active check runs first.
    expect(probeConnectionMock).toHaveBeenCalledTimes(1);
  });

  it("POST /instance/disconnect flips is_active and returns the row", async () => {
    probeConnectionMock.mockResolvedValueOnce(successProbe());
    await app.request(
      "/v1/private-channels/instance",
      { method: "POST", headers: authHeaders(), body: JSON.stringify(SANDBOX_DEFAULTS) },
      env
    );

    const res = await app.request(
      "/v1/private-channels/instance/disconnect",
      { method: "POST", headers: authHeaders(), body: "{}" },
      env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { instance: { isActive: boolean } } };
    expect(body.data.instance.isActive).toBe(false);

    const getRes = await app.request(
      "/v1/private-channels/instance",
      { headers: authHeaders() },
      env
    );
    const getBody = (await getRes.json()) as { data: PrivateChannelInstanceEnvelope };
    expect(getBody.data.instance).toBeNull();
  });

  it("POST /instance requires confirmReactivate when a same-gateway inactive row exists", async () => {
    probeConnectionMock.mockResolvedValue(successProbe());
    await app.request(
      "/v1/private-channels/instance",
      { method: "POST", headers: authHeaders(), body: JSON.stringify(SANDBOX_DEFAULTS) },
      env
    );
    await app.request(
      "/v1/private-channels/instance/disconnect",
      { method: "POST", headers: authHeaders(), body: "{}" },
      env
    );

    const withoutConfirm = await app.request(
      "/v1/private-channels/instance",
      { method: "POST", headers: authHeaders(), body: JSON.stringify(SANDBOX_DEFAULTS) },
      env
    );
    expect(withoutConfirm.status).toBe(409);
    const withoutBody = (await withoutConfirm.json()) as {
      error: {
        details?: { requiresReactivateConfirmation?: boolean; existingInstance?: { id?: string } };
      };
    };
    expect(withoutBody.error.details?.requiresReactivateConfirmation).toBe(true);
    expect(withoutBody.error.details?.existingInstance?.id).toMatch(/^pci_/);

    const withConfirm = await app.request(
      "/v1/private-channels/instance",
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ ...SANDBOX_DEFAULTS, confirmReactivate: true }),
      },
      env
    );
    expect(withConfirm.status).toBe(200);
    const reactivated = (await withConfirm.json()) as {
      data: { instance: { isActive: boolean } };
    };
    expect(reactivated.data.instance.isActive).toBe(true);
  });

  it("DELETE /instance removes the active row", async () => {
    probeConnectionMock.mockResolvedValueOnce(successProbe());
    await app.request(
      "/v1/private-channels/instance",
      { method: "POST", headers: authHeaders(), body: JSON.stringify(SANDBOX_DEFAULTS) },
      env
    );

    const res = await app.request(
      "/v1/private-channels/instance",
      { method: "DELETE", headers: authHeaders() },
      env
    );
    expect(res.status).toBe(200);

    const getRes = await app.request(
      "/v1/private-channels/instance",
      { headers: authHeaders() },
      env
    );
    const getBody = (await getRes.json()) as { data: PrivateChannelInstanceEnvelope };
    expect(getBody.data.instance).toBeNull();
  });

  it("DELETE /instance returns 404 when there is no active row", async () => {
    const res = await app.request(
      "/v1/private-channels/instance",
      { method: "DELETE", headers: authHeaders() },
      env
    );
    expect(res.status).toBe(404);
  });

  it("POST /instance returns 400 with field errors when the schema fails", async () => {
    const res = await app.request(
      "/v1/private-channels/instance",
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ ...SANDBOX_DEFAULTS, gatewayUrl: "not-a-url" }),
      },
      env
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { message: string; details?: { fieldErrors?: Record<string, string[]> } };
    };
    expect(body.error.details?.fieldErrors?.gatewayUrl?.[0]).toMatch(/http/i);
    expect(probeConnectionMock).not.toHaveBeenCalled();
  });

  it("POST /instance returns 400 when the gateway probe reports degraded", async () => {
    probeConnectionMock.mockResolvedValueOnce({
      ok: false,
      gateway: {
        status: "degraded",
        latencyMs: 88,
        health: { status: 200, ok: true, body: { status: "ok" } },
        ready: { status: 503, ok: false, body: { status: "degraded", reason: "upstream" } },
        reason: "upstream",
      },
      rpc: { ok: true, latencyMs: 11, version: "1.18.4" },
      auth: { ok: true, latencyMs: 15 },
    });

    const res = await app.request(
      "/v1/private-channels/instance",
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(SANDBOX_DEFAULTS),
      },
      env
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { details?: { gateway?: { status?: string }; rpc?: { ok?: boolean } } };
    };
    expect(body.error.details?.gateway?.status).toBe("degraded");
    expect(body.error.details?.rpc?.ok).toBe(true);
  });

  it("POST /instance returns 400 when the Solana RPC probe fails", async () => {
    probeConnectionMock.mockResolvedValueOnce({
      ok: false,
      gateway: {
        status: "ready",
        latencyMs: 42,
        health: { status: 200, ok: true, body: { status: "ok" } },
        ready: { status: 200, ok: true, body: { status: "ready" } },
      },
      rpc: { ok: false, latencyMs: 5000, error: "Timed out after 5000 ms." },
      auth: { ok: true, latencyMs: 15 },
    });

    const res = await app.request(
      "/v1/private-channels/instance",
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(SANDBOX_DEFAULTS),
      },
      env
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { details?: { rpc?: { ok?: boolean; error?: string } } };
    };
    expect(body.error.details?.rpc?.ok).toBe(false);
    expect(body.error.details?.rpc?.error).toMatch(/timed out/i);
  });
});
