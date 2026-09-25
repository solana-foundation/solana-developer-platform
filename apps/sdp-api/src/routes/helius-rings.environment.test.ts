/**
 * Helius Rings is devnet-only, and this deployment serves sandbox and
 * production projects from the same devnet-configured process (APE-691 /
 * SOLA9-303). The workflow must therefore be admitted for sandbox projects
 * only: the resolved project's environment — not just the process-wide
 * SOLANA_NETWORK — is what fences admission, and no Rings durable row may be
 * written for a project the fence rejects.
 *
 * The vulnerable baseline admitted a production project's `payments:write`
 * key into provisioning, leaving a `network='devnet'`, `status='pending'`
 * wallet row attributed to the production project.
 */

import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { createHeliusRingsWalletRepository } from "@/db/repositories";
import app from "@/index";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const ORG = { id: "org_rings_env_fence", name: "Rings Env Fence Org", slug: "rings-env-fence-org" };
const USER = { id: "usr_rings_env_fence", email: "rings-env-fence@example.test" };
const PROJECTS = {
  sandbox: "prj_rings_env_fence_sandbox",
  production: "prj_rings_env_fence_production",
} as const;
const KEYS = {
  sandbox: { id: "key_rings_env_sandbox", raw: "sk_test_rings_env_sandbox" },
  production: { id: "key_rings_env_production", raw: "sk_test_rings_env_production" },
} as const;
const SESSION_ID = "ses_rings_env_fence";

async function seedProjectWallet(environment: keyof typeof PROJECTS): Promise<void> {
  const db = getDb(env);
  await db.batch([
    db
      .prepare(
        `INSERT INTO custody_configs (id, organization_id, project_id, provider, config_encrypted, status)
         VALUES (?, ?, ?, 'privy', 'test-encrypted', 'active')`
      )
      .bind(`cfg_rings_env_${environment}`, ORG.id, PROJECTS[environment]),
    db
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
         VALUES (?, ?, ?, ?, 'active')`
      )
      .bind(
        `cw_rings_env_${environment}`,
        `cfg_rings_env_${environment}`,
        `wal_rings_env_${environment}`,
        `RingsEnv${environment === "sandbox" ? "Sandbox" : "Production"}PublicKey1111111111`
      ),
  ]);
}

async function seedProjectKey(environment: keyof typeof PROJECTS): Promise<void> {
  const key = KEYS[environment];
  const keyHash = await hashString(key.raw, env.API_KEY_PEPPER);
  const cached: CachedApiKey = {
    id: key.id,
    organizationId: ORG.id,
    projectId: PROJECTS[environment],
    role: "api_developer",
    permissions: ["payments:write"],
    environment,
    rateLimitTier: "standard",
    allowedIps: null,
    signingWalletId: null,
    status: "active",
    expiresAt: null,
  };
  await seedCachedApiKey(env, keyHash, cached);
  await getDb(env)
    .prepare(
      `INSERT INTO api_keys
         (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`
    )
    .bind(
      key.id,
      ORG.id,
      PROJECTS[environment],
      USER.id,
      `Rings Env Fence ${environment}`,
      "sk_test_rings",
      keyHash,
      "api_developer",
      JSON.stringify(["payments:write"])
    )
    .run();
}

function keyHeaders(environment: keyof typeof PROJECTS): HeadersInit {
  return {
    Authorization: `Bearer ${KEYS[environment].raw}`,
    "Content-Type": "application/json",
  };
}

async function provisionWallet(environment: keyof typeof PROJECTS): Promise<Response> {
  return app.request(
    "/v1/helius-rings/wallets",
    {
      method: "POST",
      headers: keyHeaders(environment),
      body: JSON.stringify({
        walletId: `wal_rings_env_${environment}`,
        name: "Environment fence probe",
      }),
    },
    env
  );
}

async function ringsWalletRow(environment: keyof typeof PROJECTS): Promise<unknown> {
  return createHeliusRingsWalletRepository(env).getWalletBySdpWalletId({
    organizationId: ORG.id,
    projectId: PROJECTS[environment],
    sdpWalletId: `wal_rings_env_${environment}`,
  });
}

describe("Helius Rings project environment fence", () => {
  beforeEach(async () => {
    env.HELIUS_RINGS_ENABLED = "true";
    env.SOLANA_NETWORK = "devnet";
    await seedTestDatabase(env);
    const db = getDb(env);
    await db.batch([
      db
        .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
        .bind(ORG.id, ORG.name, ORG.slug, "enterprise", "active"),
      db
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
        .bind(USER.id, USER.email, 1, "active"),
      db
        .prepare(
          `INSERT INTO organization_members (id, organization_id, user_id, role, status)
           VALUES ('om_rings_env_fence', ?, ?, 'admin', 'active')`
        )
        .bind(ORG.id, USER.id),
      db
        .prepare(
          `INSERT INTO sessions (id, user_id, organization_id, auth_method, expires_at)
           VALUES (?, ?, ?, 'session', ?)`
        )
        .bind(SESSION_ID, USER.id, ORG.id, new Date(Date.now() + 60_000).toISOString()),
    ]);
    await seedDefaultProjects(db, {
      organizationId: ORG.id,
      createdBy: USER.id,
      members: [USER.id],
      ids: PROJECTS,
    });
    await seedProjectWallet("sandbox");
    await seedProjectWallet("production");
    await seedProjectKey("sandbox");
    await seedProjectKey("production");
  });

  afterEach(async () => {
    env.HELIUS_RINGS_ENABLED = undefined;
    env.SOLANA_NETWORK = undefined;
    await clearKVStores(env);
  });

  it("refuses production provisioning and writes no rings wallet row", async () => {
    const response = await provisionWallet("production");

    expect(response.status).toBe(403);
    await expect(ringsWalletRow("production")).resolves.toBeNull();
  });

  it("keeps the sandbox project on the documented pending path", async () => {
    const response = await provisionWallet("sandbox");

    // No gateway is configured: the documented path reserves the wallet and
    // reports the pending integration honestly instead of simulating it.
    expect(response.status).toBe(503);
    await expect(ringsWalletRow("sandbox")).resolves.toMatchObject({
      project_id: PROJECTS.sandbox,
      network: "devnet",
      status: "pending",
      sdp_wallet_id: "wal_rings_env_sandbox",
    });
  });

  it("refuses every production Rings route, read and write", async () => {
    const reads = [
      ["/v1/helius-rings/health", "GET"],
      ["/v1/helius-rings/setup-status", "GET"],
      ["/v1/helius-rings/wallets", "GET"],
      ["/v1/helius-rings/rings", "GET"],
      ["/v1/helius-rings/operations", "GET"],
    ] as const;
    for (const [path, method] of reads) {
      const response = await app.request(path, { method, headers: keyHeaders("production") }, env);
      expect(response.status, `${method} ${path}`).toBe(403);
    }

    const writes = [
      [
        "/v1/helius-rings/rings",
        { name: "treasury", ringProgramId: "Stake11111111111111111111111111111111111111" },
      ],
      ["/v1/helius-rings/wallets/wal_rings_env_production/sync", undefined],
      ["/v1/helius-rings/operations", { walletId: "wrl_missing", opType: "shield" }],
    ] as const;
    for (const [path, body] of writes) {
      const response = await app.request(
        path,
        { method: "POST", headers: keyHeaders("production"), body: JSON.stringify(body) },
        env
      );
      expect(response.status, `POST ${path}`).toBe(403);
    }
  });

  it("refuses production connection setup on the internal dashboard surface", async () => {
    const response = await app.request(
      "/internal/dashboard/helius-rings/connections",
      {
        headers: {
          Cookie: `sdp_session=${SESSION_ID}`,
          "x-project-id": PROJECTS.production,
        },
      },
      env
    );
    expect(response.status).toBe(403);
  });

  it("serves sandbox connection reads on the internal dashboard surface", async () => {
    const response = await app.request(
      "/internal/dashboard/helius-rings/connections",
      {
        headers: {
          Cookie: `sdp_session=${SESSION_ID}`,
          "x-project-id": PROJECTS.sandbox,
        },
      },
      env
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { connections: [] } });
  });
});
